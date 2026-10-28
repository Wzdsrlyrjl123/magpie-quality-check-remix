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
	"net/url"
	"regexp"
	"strings"
	"time"
)

func ValidateGateway(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("请输入有效 Magpie HTTP(S) 网关地址")
	}
	return nil
}

// The shared client timeout is a ceiling; each call narrows it to ProbeTimeout.
var client = &http.Client{Timeout: 600 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("不允许网关重定向") }}

// EffortLevels is the reasoning-effort vocabulary Magpie accepts, low to high.
// The gateway reports a subset per model; an empty value means "do not send".
var EffortLevels = []string{"low", "medium", "high", "xhigh", "max", "ultra"}

func effortRank(level string) int {
	for i, l := range EffortLevels {
		if l == level {
			return i
		}
	}
	return -1
}

// NormalizeLevels keeps known levels, de-duplicates them and orders them weak to strong.
func NormalizeLevels(levels []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range levels {
		level := strings.ToLower(strings.TrimSpace(raw))
		if effortRank(level) < 0 || seen[level] {
			continue
		}
		seen[level] = true
		out = append(out, level)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && effortRank(out[j-1]) > effortRank(out[j]); j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

// ValidateEffort rejects unknown values so a typo cannot silently fall back to
// the provider default. Empty means "leave it to Magpie".
func ValidateEffort(effort string) (string, error) {
	level := strings.ToLower(strings.TrimSpace(effort))
	if level == "" {
		return "", nil
	}
	if effortRank(level) < 0 {
		return "", fmt.Errorf("无效的思考强度 %q；可选 %s，或留空交给 Magpie 默认值", effort, strings.Join(EffortLevels, " / "))
	}
	return level, nil
}

// OutputBudget is the per-request max_tokens for a probe. Reasoning tokens are
// billed against this budget, so an 8192 cap could be spent entirely on thinking
// and leave no visible answer: measured milk probes needed >8192 at every level
// (low hit 8192 with an empty reply). The cap still bounds runaway output.
func OutputBudget(effort string) int {
	switch effort {
	case "high":
		return 32768
	case "xhigh", "max", "ultra":
		return 65536
	default:
		return 24576
	}
}

// ProbeTimeout scales the per-request deadline with the effort level. A measured
// "max" milk probe took over two minutes, so a flat 180s would cut off work that
// was still making progress.
func ProbeTimeout(effort string) time.Duration {
	switch effort {
	case "high":
		return 360 * time.Second
	case "xhigh", "max", "ultra":
		return 540 * time.Second
	default:
		return 240 * time.Second
	}
}

type Model struct {
	ID     string   `json:"id"`
	Group  string   `json:"group"`
	Levels []string `json:"levels,omitempty"`
	// Reasoning reports whether the model reasons at all; nil means the
	// gateway published no such field.
	Reasoning *bool `json:"reasoning,omitempty"`
}

func Models(ctx context.Context, c Config) ([]Model, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := ValidateGateway(c.GatewayURL); err != nil {
		return nil, err
	}
	base := strings.TrimRight(c.GatewayURL, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.GatewayKey)
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("无法读取 Magpie 模型列表")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("模型列表 HTTP %d", resp.StatusCode)
	}
	var data struct {
		Data []struct {
			ID              string   `json:"id"`
			OwnedBy         string   `json:"owned_by"`
			Reasoning       *bool    `json:"reasoning"`
			ReasoningLevels []string `json:"reasoning_levels"`
			SupportedLevels []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"data"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 4*1024*1024)).Decode(&data); err != nil {
		return nil, errors.New("模型列表无效")
	}
	out := []Model{}
	for _, m := range data.Data {
		group := m.OwnedBy
		if i := strings.Index(m.ID, "/"); i > 0 {
			group = m.ID[:i]
		}
		levels := m.ReasoningLevels
		if len(levels) == 0 {
			for _, s := range m.SupportedLevels {
				if s.Effort != "" {
					levels = append(levels, s.Effort)
				}
			}
		}
		out = append(out, Model{ID: m.ID, Group: group, Levels: NormalizeLevels(levels), Reasoning: m.Reasoning})
	}
	return out, nil
}

func Call(ctx context.Context, c Config, model, prompt string) (string, int, error) {
	answer, tokens, _, err := call(ctx, c, model, prompt, "", nil)
	return answer, tokens, err
}

// call returns the answer, total tokens, the reasoning-token slice of them and
// any error. reasoning is zero when the provider does not report it.
func call(ctx context.Context, c Config, model, prompt, effort string, progress func(string)) (string, int, int, error) {
	payload := map[string]any{"model": model, "stream": progress != nil, "max_tokens": OutputBudget(effort), "messages": []any{map[string]string{"role": "user", "content": prompt}}}
	// Magpie forwards reasoning effort to the upstream provider; omitting the
	// field keeps the provider's own default.
	if effort != "" {
		payload["reasoning_effort"] = effort
	}
	if progress != nil {
		payload["stream_options"] = map[string]bool{"include_usage": true}
	}
	b, _ := json.Marshal(payload)
	base := strings.TrimRight(c.GatewayURL, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return "", 0, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.GatewayKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", 0, 0, fmt.Errorf("Magpie HTTP %d", resp.StatusCode)
	}
	if progress != nil && strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		answer, tokens, reasoning, err := readAnswerStream(resp.Body, progress)
		return answer, tokens, reasoning, err
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024+1))
	if err != nil {
		return "", 0, 0, err
	}
	if len(raw) > 4*1024*1024 {
		return "", 0, 0, errors.New("回复超过大小限制")
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Finish string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			Total            int `json:"total_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			Details          struct {
				Reasoning int `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if err = json.Unmarshal(raw, &out); err != nil {
		return "", 0, 0, errors.New("无法解析完整回复")
	}
	if len(out.Choices) != 1 {
		return "", 0, 0, errors.New("缺少唯一有效回答")
	}
	// A reasoning-only reply can spend its whole budget before any content.
	reasoning := out.Usage.Details.Reasoning
	ch := out.Choices[0]
	if ch.Finish != "stop" {
		if reasoning > 0 && strings.TrimSpace(ch.Message.Content) == "" {
			return ch.Message.Content, out.Usage.Total, reasoning, fmt.Errorf("思考用尽 %d token 预算但未产生正文（finish_reason=%s）；请降低思考强度，或改用支持更长输出的模型", out.Usage.Total, ch.Finish)
		}
		return ch.Message.Content, out.Usage.Total, reasoning, errors.New("回复未正常结束或被截断")
	}
	if strings.TrimSpace(ch.Message.Content) == "" {
		return "", out.Usage.Total, reasoning, errors.New("空回答")
	}
	return ch.Message.Content, out.Usage.Total, reasoning, nil
}

func readAnswerStream(body io.Reader, progress func(string)) (string, int, int, error) {
	const limit = 4 * 1024 * 1024
	scanner := bufio.NewScanner(io.LimitReader(body, limit+1))
	scanner.Buffer(make([]byte, 4096), limit)
	var answer strings.Builder
	tokens, reasoning, bytesRead := 0, 0, 0
	finished, done := false, false
	var event []string
	consume := func() error {
		if len(event) == 0 {
			return nil
		}
		data := strings.Join(event, "\n")
		event = nil
		if data == "[DONE]" {
			done = true
			return nil
		}
		var chunk struct {
			Choices []struct {
				Index int `json:"index"`
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				Finish *string `json:"finish_reason"`
			} `json:"choices"`
			Usage struct {
				Total int `json:"total_tokens"`
				// Gateways differ: reasoning tokens appear nested or not at all.
				CompletionTokens int `json:"completion_tokens"`
				Details          struct {
					Reasoning int `json:"reasoning_tokens"`
				} `json:"completion_tokens_details"`
				ReasoningDirect int `json:"reasoning_tokens"`
			} `json:"usage"`
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil || len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return errors.New("无法解析流式回复")
		}
		if chunk.Usage.Total > 0 {
			tokens = chunk.Usage.Total
		}
		if chunk.Usage.Details.Reasoning > 0 {
			reasoning = chunk.Usage.Details.Reasoning
		} else if chunk.Usage.ReasoningDirect > 0 {
			reasoning = chunk.Usage.ReasoningDirect
		}
		for _, choice := range chunk.Choices {
			if choice.Index != 0 {
				return errors.New("缺少唯一有效回答")
			}
			answer.WriteString(choice.Delta.Content)
			if choice.Delta.Content != "" {
				progress(answer.String())
			}
			if choice.Finish != nil {
				if *choice.Finish != "stop" {
					return errors.New("回复未正常结束或被截断")
				}
				finished = true
			}
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		bytesRead += len(line) + 1
		if bytesRead > limit {
			return answer.String(), tokens, reasoning, errors.New("回复超过大小限制")
		}
		if line == "" {
			if err := consume(); err != nil {
				return answer.String(), tokens, reasoning, err
			}
			if done {
				break
			}
		} else if strings.HasPrefix(line, "data:") {
			event = append(event, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return answer.String(), tokens, reasoning, err
	}
	if err := consume(); err != nil {
		return answer.String(), tokens, reasoning, err
	}
	if !finished || !done {
		return answer.String(), tokens, reasoning, errors.New("流式回复连接中断或未完整结束")
	}
	if strings.TrimSpace(answer.String()) == "" {
		return "", tokens, reasoning, errors.New("空回答")
	}
	return answer.String(), tokens, reasoning, nil
}

// Strong reasoning levels tend to wrap the final value in LaTeX, e.g.
// `\boxed{46.24\text{ inches}}`. Allow a short run of markup between the number
// and the unit so those answers are not graded as failures.
var finalNumber = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)[*_` + "`" + `\s{}\\]*(?:\\text\{|\\mathrm\{|\\,)?\s*(?:inches\b|inch\b|英寸)`)

var boxedValue = regexp.MustCompile(`(?i)\\boxed\{\s*\$?\s*(\d+(?:\.\d+)?)`)

// A whole-answer value: `46.24`, `**46.24**`, `\boxed{46.24}`, `46.24 inches`.
var wholeAnswer = regexp.MustCompile(`(?i)^[\s*_` + "`" + `$\\{}\[\]()]*46\.24(?:\s*(?:\\?text\{)?(?:\\?,)?\s*(?:inches|inch|英寸)['′]?)?[\s*_` + "`" + `$\\{}\[\]().。]*$`)

func Grade(id, answer string) string {
	if id != "milk" {
		return "manual"
	}
	// The reply may be nothing but the value, wrapped however the model likes.
	if wholeAnswer.MatchString(answer) {
		return "passed"
	}
	// Prefer an explicit boxed final answer when the reply marks one.
	if boxed := boxedValue.FindAllStringSubmatch(answer, -1); len(boxed) > 0 {
		if boxed[len(boxed)-1][1] == "46.24" {
			return "passed"
		}
		return "failed"
	}
	matches := finalNumber.FindAllStringSubmatch(answer, -1)
	if len(matches) == 0 {
		return "failed"
	}
	if matches[len(matches)-1][1] == "46.24" {
		return "passed"
	}
	return "failed"
}
