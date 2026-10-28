package check

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// routePrompt is a minimal connectivity request.
const routePrompt = "只回复 OK。"

const routeMaxBytes = 512 * 1024

// RouteRecordCap bounds persisted route checks; the log view covers older data.
const RouteRecordCap = 300

// RouteCheck is one route probe: what was requested versus what was served.
type RouteCheck struct {
	ResponseID        string   `json:"response_id"`
	UpstreamStatus    string   `json:"upstream_status"`
	UpstreamModel     string   `json:"upstream_model"`
	UpstreamModels    []string `json:"upstream_models,omitempty"`
	UpstreamSentModel string   `json:"upstream_sent_model,omitempty"`
	UpstreamSource    string   `json:"upstream_source,omitempty"`
	UpstreamConflict  bool     `json:"upstream_conflict,omitempty"`
	UpstreamNote      string   `json:"upstream_note,omitempty"`
	ID                string   `json:"id"`
	Model             string   `json:"model"`
	Served            string   `json:"served"`
	Provider          string   `json:"provider"`
	BodyModel         string   `json:"body_model"`
	SelfClaim         string   `json:"self_claim"`
	Status            int      `json:"status"`
	Tokens            int      `json:"tokens"`
	Effort            string   `json:"effort,omitempty"`
	MS                int      `json:"ms"`
	Error             string   `json:"error,omitempty"`
	// Direct is true when the probe alias was unknown to the gateway, so the
	// check ran on the plain model ID instead. Routing evidence is unaffected.
	Direct bool      `json:"direct,omitempty"`
	Time   time.Time `json:"time"`
}

// probeRoute sends one minimal request and reports the gateway's own routing
// verdict. It is a short prompt, so the shared client's ceiling is enough.
func probeRoute(ctx context.Context, c Config, alias, model, effort string) RouteCheck {
	return probeRouteWithObservations(ctx, c, alias, model, effort, "")
}

func probeRouteWithObservations(ctx context.Context, c Config, alias, model, effort, observationDir string) RouteCheck {
	started := time.Now()
	out, retry := probeRouteOnce(ctx, c, alias, model, effort, started, observationDir)
	// The probe alias is stripped by the gate middleware. When Magpie has not
	// loaded it (plugin inactive, or the file was just rewritten), the gateway
	// answers 404 for the alias. Routing can still be checked on the plain model
	// ID, so fall back rather than reporting a failure the user cannot act on.
	if retry && ctx.Err() == nil {
		out, _ = probeRouteOnce(ctx, c, model, model, effort, started, observationDir)
		out.Direct = true
	}
	return out
}

func probeRouteOnce(ctx context.Context, c Config, alias, model, effort string, started time.Time, observationDir string) (RouteCheck, bool) {
	out := RouteCheck{ID: Secret()[:12], Model: model, Time: started, Effort: effort, UpstreamStatus: "not_captured"}
	fail := func(reason string) (RouteCheck, bool) {
		out.Error = reason
		out.MS = int(time.Since(started) / time.Millisecond)
		return out, false
	}
	payload := map[string]any{
		"model":    alias,
		"messages": []any{map[string]string{"role": "user", "content": routePrompt}},
		"stream":   false,
	}
	// max_tokens must stay above the thinking budget, otherwise a reasoning
	// model spends it all on reasoning and returns an empty answer.
	payload["max_tokens"] = OutputBudget(effort)
	if effort != "" {
		payload["reasoning_effort"] = effort
	}
	b, _ := json.Marshal(payload)
	base := strings.TrimRight(c.GatewayURL, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return fail(err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+c.GatewayKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return fail("核对已取消")
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fail("上游无响应，核对超时")
		}
		return fail("无法连接网关：" + err.Error())
	}
	defer resp.Body.Close()
	out.Status = resp.StatusCode
	// These headers report gateway routing, not the raw upstream model.
	out.Served = strings.TrimSpace(resp.Header.Get("X-Magpie-Model"))
	out.Provider = strings.TrimSpace(resp.Header.Get("X-Magpie-Provider"))
	raw, err := io.ReadAll(io.LimitReader(resp.Body, routeMaxBytes+1))
	if err != nil {
		return fail("读取回复失败：" + err.Error())
	}
	if len(raw) > routeMaxBytes {
		return fail("回复超过大小限制")
	}
	var data struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			Total int `json:"total_tokens"`
		} `json:"usage"`
		Error json.RawMessage `json:"error"`
	}
	retry := false
	if json.Unmarshal(raw, &data) == nil {
		out.ResponseID = data.ID
		out.BodyModel = strings.TrimSpace(data.Model)
		applyUpstreamObservation(&out, observationDir, started, time.Now())
		out.Tokens = data.Usage.Total
		if len(data.Choices) > 0 {
			out.SelfClaim = truncateRunes(strings.TrimSpace(data.Choices[0].Message.Content), 400)
		}
		if len(data.Error) > 0 && string(data.Error) != "null" {
			var e struct {
				Message string `json:"message"`
				Code    any    `json:"code"`
			}
			if json.Unmarshal(data.Error, &e) == nil {
				if e.Message != "" {
					out.Error = truncateRunes(e.Message, 400)
				} else if e.Code != nil {
					out.Error = truncateRunes(fmt.Sprint(e.Code), 400)
				}
			}
			if out.Error == "" {
				out.Error = truncateRunes(string(data.Error), 400)
			}
		}
	} else if resp.StatusCode != 200 {
		out.Error = truncateRunes(strings.TrimSpace(string(raw)), 400)
	}
	if resp.StatusCode != 200 && out.Error == "" {
		out.Error = fmt.Sprintf("网关 HTTP %d", resp.StatusCode)
	}
	// Only the alias may be retried, and only when the gateway says it does not
	// know that name — any other failure is reported as-is.
	if alias != model && resp.StatusCode == 404 && strings.Contains(out.Error, alias) {
		retry = true
	}
	out.MS = int(time.Since(started) / time.Millisecond)
	return out, retry
}

func truncateRunes(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit]) + "…"
}

// CheckRoute starts an asynchronous route probe. Results arrive through
// /api/state; nothing is written to the quality history or the gate.
func (s *Service) CheckRoute(model, effort string) error {
	model = strings.TrimSpace(model)
	if model == "" || len(model) > 512 || strings.ContainsAny(model, "\r\n") || strings.HasPrefix(model, "quality-probe/") {
		return errors.New("请输入完整模型 ID，例如 provider/model")
	}
	level, err := ValidateEffort(effort)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.Config.GatewayURL == "" || s.state.Config.GatewayKey == "" {
		return errors.New("请配置 Magpie 网关 URL 和 Key")
	}
	if s.routeRunning[model] {
		return errors.New("该模型的路由核对正在进行中")
	}
	if s.dayCountLocked(model) >= s.state.Config.DailyLimit {
		return errors.New("每日请求预算已耗尽")
	}
	cfg := s.state.Config
	alias := "quality-probe/" + s.state.Alias + "/" + model
	if s.routeRunning == nil {
		s.routeRunning = map[string]bool{}
	}
	s.routeRunning[model] = true
	ctx, cancel := context.WithTimeout(s.ctx, ProbeTimeout(level))
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		result := probeRouteWithObservations(ctx, cfg, alias, model, level, filepath.Join(s.dir, "upstream-observations"))
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.routeRunning, model)
		s.state.Routes = append(s.state.Routes, result)
		if len(s.state.Routes) > RouteRecordCap {
			s.state.Routes = s.state.Routes[len(s.state.Routes)-RouteRecordCap:]
		}
		s.saveLocked()
	}()
	return nil
}

// dayCountLocked counts today's requests for one model across quality probes
// and route checks, so the daily budget cannot be bypassed by the new view.
func (s *Service) dayCountLocked(model string) int {
	day := time.Now().UTC().Format("2006-01-02")
	count := s.state.ClearedUsage[day][model]
	for _, r := range s.state.Results {
		if r.Model == model && r.Time.UTC().Format("2006-01-02") == day {
			count++
		}
	}
	for _, r := range s.state.Routes {
		if r.Model == model && r.Time.UTC().Format("2006-01-02") == day {
			count++
		}
	}
	return count
}

// RouteRunning reports which models have a route check in flight.
func (s *Service) RouteRunning() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.routeRunning))
	for model := range s.routeRunning {
		out = append(out, model)
	}
	return out
}

func (s *Service) ClearRoutes() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.routeRunning) > 0 {
		return errors.New("路由核对进行中，请完成后再清理")
	}
	previous := s.state.Routes
	s.state.Routes = nil
	if err := s.saveLocked(); err != nil {
		s.state.Routes = previous
		return err
	}
	return nil
}

// DefaultUsagePath points at Magpie's request log, which records req → served.
func DefaultUsagePath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "magpie", "usage.jsonl")
}

// ResolveUsagePath prefers the configured path over the default location.
func ResolveUsagePath(path string) string {
	if strings.TrimSpace(path) != "" {
		return path
	}
	return DefaultUsagePath()
}

// UsageRows reads the tail of Magpie's request log and returns req → served
// receipts, newest first. Lines that are not the expected JSON are skipped so a
// partially written tail line cannot break the view.
func UsageRows(path string, limit int) ([]map[string]any, error) {
	path = ResolveUsagePath(path)
	if path == "" {
		return nil, errors.New("未配置 Magpie 请求日志路径")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("请求日志不可读：" + filepath.Base(path))
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	const window = 512 * 1024
	start := info.Size() - window
	if start < 0 {
		start = 0
	}
	if _, err = f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 500 {
		limit = 100
	}
	rows := make([]map[string]any, 0, limit)
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var item struct {
			T        string `json:"t"`
			Agent    string `json:"agent"`
			Req      string `json:"req"`
			Model    string `json:"model"`
			Served   string `json:"served"`
			Provider string `json:"provider"`
			Account  string `json:"providerAccount"`
			Host     string `json:"host"`
			Status   int    `json:"status"`
			MS       int    `json:"ms"`
			Ep       string `json:"ep"`
			Err      string `json:"err"`
		}
		if json.Unmarshal(line, &item) != nil || item.Req == "" {
			continue
		}
		served := item.Served
		if served == "" {
			served = item.Model
		}
		account := item.Account
		if account == "" {
			account = item.Host
		}
		rows = append(rows, map[string]any{
			"t":        item.T,
			"agent":    item.Agent,
			"req":      item.Req,
			"served":   served,
			"provider": item.Provider,
			"account":  account,
			"status":   item.Status,
			"ms":       item.MS,
			"ep":       item.Ep,
			"err":      item.Err,
		})
	}
	if err := scanner.Err(); err != nil && len(rows) == 0 {
		return nil, err
	}
	if len(rows) > limit {
		rows = rows[len(rows)-limit:]
	}
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}
