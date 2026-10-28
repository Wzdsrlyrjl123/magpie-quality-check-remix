package check

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newGatewayStub(t *testing.T, handler func(http.ResponseWriter)) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler(w)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func TestUsageRowsReadsTailAndReverses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	lines := []string{
		`{"t":"2026-10-27T00:00:01+08:00","agent":"dsh","req":"group/auto-dfmodel","model":"dfmodel","served":"dfmodel","provider":"qoder","providerAccount":"a@b.c","status":200,"ms":1200}`,
		`{"t":"2026-10-27T00:00:02+08:00","agent":"pi","req":"workbuddy/deepseek-v4.1-flash","model":"deepseek-v4.1-flash","provider":"workbuddy","host":"copilot","status":200,"ms":800}`,
		`{ broken json`,
		`{"t":"2026-10-27T00:00:03+08:00","agent":"codex","req":"x/y","status":499,"err":"canceled"}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	rows, err := UsageRows(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("期望 3 条有效记录，实际 %d", len(rows))
	}
	// 最新在前
	if rows[0]["req"] != "x/y" {
		t.Errorf("首条应为最新记录，实际 %v", rows[0]["req"])
	}
	// served 缺失时回落到 model 字段
	if rows[2]["served"] != "dfmodel" {
		t.Errorf("served 回落失败：%v", rows[2]["served"])
	}
	// account 缺失时回落到 host
	if rows[1]["account"] != "copilot" {
		t.Errorf("account 回落失败：%v", rows[1]["account"])
	}
	if rows[1]["served"] != "deepseek-v4.1-flash" {
		t.Errorf("served 应取 model 字段：%v", rows[1]["served"])
	}
}

func TestUsageRowsLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	var b strings.Builder
	for i := 0; i < 20; i++ {
		b.WriteString(`{"req":"m/` + string(rune('a'+i)) + `","served":"s"}` + "\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0600); err != nil {
		t.Fatal(err)
	}
	rows, err := UsageRows(path, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 {
		t.Fatalf("期望裁剪到 5 条，实际 %d", len(rows))
	}
	if rows[0]["req"] != "m/t" {
		t.Errorf("裁剪后首条应为最后一行，实际 %v", rows[0]["req"])
	}
}

func TestUsageRowsMissingFile(t *testing.T) {
	if _, err := UsageRows(filepath.Join(t.TempDir(), "nope.jsonl"), 10); err == nil {
		t.Fatal("文件不存在时应报错")
	}
}

func TestProbeRouteCapturesHeaders(t *testing.T) {
	server := newGatewayStub(t, func(w http.ResponseWriter) {
		w.Header().Set("X-Magpie-Model", "qoder/dfmodel")
		w.Header().Set("X-Magpie-Provider", "qoder")
		w.WriteHeader(200)
		w.Write([]byte(`{"model":"dfmodel","choices":[{"message":{"content":"Qoder 的 dfmodel"}}],"usage":{"total_tokens":42}}`))
	})
	cfg := Config{GatewayURL: server, GatewayKey: "magpie"}
	result := probeRoute(context.Background(), cfg, "quality-probe/alias/group/auto-dfmodel", "group/auto-dfmodel", "")
	if result.Served != "qoder/dfmodel" {
		t.Errorf("应记录 X-Magpie-Model，实际 %q", result.Served)
	}
	if result.Provider != "qoder" {
		t.Errorf("应记录 X-Magpie-Provider，实际 %q", result.Provider)
	}
	if result.BodyModel != "dfmodel" {
		t.Errorf("应记录返回体 model，实际 %q", result.BodyModel)
	}
	if result.Tokens != 42 {
		t.Errorf("应记录 token 用量，实际 %d", result.Tokens)
	}
	if !strings.Contains(result.SelfClaim, "dfmodel") {
		t.Errorf("应保留模型自述，实际 %q", result.SelfClaim)
	}
	if result.Error != "" {
		t.Errorf("不应有错误，实际 %q", result.Error)
	}
	if result.ID == "" || len(result.ID) != 12 {
		t.Errorf("应生成 12 位记录 ID，实际 %q", result.ID)
	}
}

func TestProbeRouteReportsUpstreamError(t *testing.T) {
	server := newGatewayStub(t, func(w http.ResponseWriter) {
		w.WriteHeader(429)
		w.Write([]byte(`{"error":{"message":"额度已用尽","code":"rate_limited"}}`))
	})
	cfg := Config{GatewayURL: server, GatewayKey: "magpie"}
	result := probeRoute(context.Background(), cfg, "quality-probe/a/b", "b", "")
	if result.Status != 429 {
		t.Errorf("应记录状态码 429，实际 %d", result.Status)
	}
	if !strings.Contains(result.Error, "额度已用尽") {
		t.Errorf("应暴露上游错误信息，实际 %q", result.Error)
	}
}

func TestProbeRouteFallsBackWhenAliasUnknown(t *testing.T) {
	var seen []string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		seen = append(seen, body.Model)
		if strings.HasPrefix(body.Model, "quality-probe/") {
			// The gate middleware did not strip the alias.
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"message":"magpie knows no model \"` + body.Model + `\""}}`))
			return
		}
		w.Header().Set("X-Magpie-Model", "served/direct")
		w.Header().Set("X-Magpie-Provider", "chan")
		w.WriteHeader(200)
		w.Write([]byte(`{"model":"direct","choices":[{"message":{"content":"我是 direct"}}]}`))
	}))
	defer stub.Close()
	cfg := Config{GatewayURL: stub.URL, GatewayKey: "magpie"}
	result := probeRoute(context.Background(), cfg, "quality-probe/a/group/x", "group/x", "")
	if len(seen) != 2 {
		t.Fatalf("别名 404 后应回退一次，实际请求 %d 次：%v", len(seen), seen)
	}
	if seen[0] == seen[1] {
		t.Fatalf("回退应改用纯模型 ID，实际两次都是 %q", seen[0])
	}
	if result.Served != "served/direct" {
		t.Errorf("回退成功时应记录路由回执，实际 %q", result.Served)
	}
	if result.Error != "" {
		t.Errorf("回退成功时不应带错误，实际 %q", result.Error)
	}
	if !result.Direct {
		t.Error("回退时应标记 direct，便于解释为何没走探针别名")
	}
	if result.Model != "group/x" {
		t.Errorf("记录里应保留用户请求的模型 ID，实际 %q", result.Model)
	}
}

func TestProbeRouteDoesNotFallBackOnOtherErrors(t *testing.T) {
	var hits int
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"message":"no such route"}}`))
	}))
	defer stub.Close()
	cfg := Config{GatewayURL: stub.URL, GatewayKey: "magpie"}
	result := probeRoute(context.Background(), cfg, "quality-probe/a/b", "b", "")
	if hits != 1 {
		t.Fatalf("与别名无关的 404 不应重试，实际请求 %d 次", hits)
	}
	if result.Direct {
		t.Error("未回退时不应标记 direct")
	}
	if result.Error == "" {
		t.Error("应保留原始错误")
	}
}

func TestProbeRouteTimeout(t *testing.T) {
	server := newGatewayStub(t, func(w http.ResponseWriter) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(200)
		w.Write([]byte(`{"choices":[{"message":{"content":"太慢"}}]}`))
	})
	cfg := Config{GatewayURL: server, GatewayKey: "magpie"}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := probeRoute(ctx, cfg, "quality-probe/a/b", "b", "")
	if result.Error == "" {
		t.Fatal("超时应产生错误说明")
	}
	if !strings.Contains(result.Error, "超时") && !strings.Contains(result.Error, "取消") {
		t.Errorf("错误应说明超时或取消，实际 %q", result.Error)
	}
}

func TestCheckRouteValidation(t *testing.T) {
	s, err := New(t.TempDir(), filepath.Join(t.TempDir(), "gate.js"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.CheckRoute("", ""); err == nil {
		t.Error("空模型应被拒绝")
	}
	if err := s.CheckRoute("a/b", ""); err == nil {
		t.Error("未配置网关时应被拒绝")
	}
	if err := s.Configure(Config{GatewayURL: "http://127.0.0.1:1", GatewayKey: "magpie", DailyLimit: 10}); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckRoute("a/b", "bogus"); err == nil {
		t.Error("无效思考强度应被拒绝")
	}
	if err := s.CheckRoute("a\nb", ""); err == nil {
		t.Error("含换行的模型 ID 应被拒绝")
	}
}

func TestCheckRouteStoresRecord(t *testing.T) {
	server := newGatewayStub(t, func(w http.ResponseWriter) {
		w.Header().Set("X-Magpie-Model", "served/model")
		w.Header().Set("X-Magpie-Provider", "chan")
		w.WriteHeader(200)
		w.Write([]byte(`{"choices":[{"message":{"content":"hello"}}],"usage":{"total_tokens":7}}`))
	})
	dir := t.TempDir()
	s, err := New(dir, filepath.Join(dir, "gate.js"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Configure(Config{GatewayURL: server, GatewayKey: "magpie", DailyLimit: 30}); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckRoute("group/auto-dfmodel", "high"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		state, _ := s.Snapshot()
		if len(state.Routes) == 1 {
			got := state.Routes[0]
			if got.Served != "served/model" || got.Provider != "chan" {
				t.Fatalf("路由回执不完整：%+v", got)
			}
			if got.Model != "group/auto-dfmodel" || got.Effort != "high" {
				t.Fatalf("请求字段不正确：%+v", got)
			}
			// 核对不应写入质量检测记录，也不应改变门禁状态。
			if len(state.Results) != 0 {
				t.Fatalf("路由核对不应产生质量记录，实际 %d 条", len(state.Results))
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("等待路由核对结果超时")
}

func TestCheckRouteDeduplicates(t *testing.T) {
	release := make(chan struct{})
	server := newGatewayStub(t, func(w http.ResponseWriter) {
		<-release
		w.WriteHeader(200)
		w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	})
	dir := t.TempDir()
	s, err := New(dir, filepath.Join(dir, "gate.js"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Configure(Config{GatewayURL: server, GatewayKey: "magpie", DailyLimit: 30}); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckRoute("a/b", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckRoute("a/b", ""); err == nil {
		t.Fatal("同一模型并发核对应被拒绝")
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(s.RouteRunning()) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("等待核对完成超时")
}

func TestSnapshotHidesAliasWithRoutes(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir, filepath.Join(dir, "gate.js"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.mu.Lock()
	s.state.Routes = []RouteCheck{{ID: "abc", Model: "a/b", Served: "c/d"}}
	s.mu.Unlock()
	state, _ := s.Snapshot()
	if state.Alias != "" {
		t.Error("快照不应暴露探针别名")
	}
	if len(state.Routes) != 1 {
		t.Fatal("快照应包含路由记录")
	}
	raw, _ := json.Marshal(state)
	if strings.Contains(string(raw), "quality-probe") {
		t.Error("快照不应出现探针别名")
	}
}
