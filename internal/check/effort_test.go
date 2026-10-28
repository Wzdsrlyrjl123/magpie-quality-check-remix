package check

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func reportLevels(levels ...string) []any {
	out := make([]any, len(levels))
	for i, level := range levels {
		out[i] = map[string]string{"effort": level}
	}
	return out
}

// bodyRecorder captures the reasoning_effort each probe sends.
type bodyRecorder struct {
	mu    sync.Mutex
	sent  []string
	model []string
}

func (b *bodyRecorder) server(t *testing.T, answer string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model    string  `json:"model"`
			Effort   *string `json:"reasoning_effort"`
			Messages []struct{ Content string }
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		b.mu.Lock()
		b.model = append(b.model, body.Model)
		if body.Effort == nil {
			b.sent = append(b.sent, "")
		} else {
			b.sent = append(b.sent, *body.Effort)
		}
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": answer}, "finish_reason": "stop"}},
			"usage":   map[string]any{"total_tokens": 12, "completion_tokens_details": map[string]int{"reasoning_tokens": 5}},
		})
	}))
}

func (b *bodyRecorder) efforts() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.sent...)
}

func TestEffortSentOnlyWhenConfigured(t *testing.T) {
	rec := &bodyRecorder{}
	up := rec.server(t, "46.24 inches")
	defer up.Close()
	s := fixture(t)
	if err := s.Configure(Config{GatewayURL: up.URL, GatewayKey: "fixture", DailyLimit: 120}); err != nil {
		t.Fatal(err)
	}
	s.SetTarget("a/solo", true)

	if err := s.Trigger("a/solo", "milk", true); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, s)
	if got := rec.efforts(); len(got) != 1 || got[0] != "" {
		t.Fatalf("default probe sent an effort: %v", got)
	}

	if err := s.SetEffort("a/solo", "high"); err != nil {
		t.Fatal(err)
	}
	if err := s.Trigger("a/solo", "milk", true); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, s)
	got := rec.efforts()
	if len(got) != 2 || got[1] != "high" {
		t.Fatalf("target effort not applied: %v", got)
	}
	state, _ := s.Snapshot()
	if last := state.Results[len(state.Results)-1]; last.Effort != "high" || last.ReasoningTokens != 5 {
		t.Fatalf("effort not recorded: %+v", last)
	}
}

func TestEffortInheritanceAndOverride(t *testing.T) {
	rec := &bodyRecorder{}
	up := rec.server(t, "46.24 inches")
	defer up.Close()
	s := fixture(t)
	if err := s.Configure(Config{GatewayURL: up.URL, GatewayKey: "fixture", DailyLimit: 120, Effort: "medium"}); err != nil {
		t.Fatal(err)
	}
	s.SetTarget("a/solo", true)
	s.SetTarget("a/luna", true)

	// Both inherit the global default.
	for _, model := range []string{"a/solo", "a/luna"} {
		if err := s.Trigger(model, "milk", true); err != nil {
			t.Fatal(err)
		}
		waitIdle(t, s)
	}
	if got := rec.efforts(); len(got) != 2 || got[0] != "medium" || got[1] != "medium" {
		t.Fatalf("global default unused: %v", got)
	}

	// A target override beats the default and leaves the other target alone.
	if err := s.SetEffort("a/solo", "max"); err != nil {
		t.Fatal(err)
	}
	if err := s.Trigger("a/solo", "milk", true); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, s)
	if err := s.Trigger("a/luna", "milk", true); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, s)
	got := rec.efforts()
	if len(got) != 4 || got[2] != "max" || got[3] != "medium" {
		t.Fatalf("override not scoped to its target: %v", got)
	}

	// Clearing the override falls back to the default again.
	if err := s.SetEffort("a/solo", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Trigger("a/solo", "milk", true); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, s)
	if got := rec.efforts(); got[len(got)-1] != "medium" {
		t.Fatalf("cleared override stuck: %v", got)
	}
}

func TestEffortRejectsUnknownValue(t *testing.T) {
	s := fixture(t)
	s.SetTarget("a/solo", true)
	s.mu.Lock()
	s.state.Config = Config{GatewayURL: "http://127.0.0.1:1", GatewayKey: "fixture", DailyLimit: 120}
	s.mu.Unlock()
	for _, bad := range []string{"HIGHEST", "turbo", "high "} {
		if err := s.SetEffort("a/solo", bad); err == nil && bad != "high " {
			t.Fatalf("accepted %q", bad)
		}
	}
	if err := s.SetEffort("a/solo", "  High "); err != nil {
		t.Fatalf("case and padding not normalized: %v", err)
	}
	if err := s.SetEffort("missing/model", "high"); err == nil {
		t.Fatal("accepted effort for unknown model")
	}
	// An invalid level must not reach the gateway either.
	if err := s.TriggerWithEffort("a/solo", "milk", true, "bogus"); err == nil {
		t.Fatal("trigger accepted invalid effort")
	}
	state, _ := s.Snapshot()
	if state.Targets["a/solo"].Effort != "high" {
		t.Fatal("normalized value not stored")
	}
}

func TestModelTraceUsesConfiguredEffort(t *testing.T) {
	rec := &bodyRecorder{}
	up := rec.server(t, "1, 2, 3")
	defer up.Close()
	s := fixture(t)
	if err := s.Configure(Config{GatewayURL: up.URL, GatewayKey: "fixture", DailyLimit: 120}); err != nil {
		t.Fatal(err)
	}
	s.SetTarget("a/solo", true)
	if err := s.SetEffort("a/solo", "low"); err != nil {
		t.Fatal(err)
	}
	if err := s.TriggerModelTrace("a/solo"); err != nil {
		t.Fatal(err)
	}
	s.wg.Wait()
	got := rec.efforts()
	if len(got) != 3 {
		t.Fatalf("expected 3 challenges, got %d", len(got))
	}
	for _, level := range got {
		if level != "low" {
			t.Fatalf("fingerprint batch mixed efforts: %v", got)
		}
	}
	state, _ := s.Snapshot()
	for _, result := range state.Results {
		if result.Effort != "low" || result.ReasoningTokens != 5 {
			t.Fatalf("batch result missing effort metadata: %+v", result)
		}
	}
}

func TestEffortDiscoverReadsGatewayLevels(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Error("unexpected path", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []any{
			map[string]any{"id": "a/solo", "owned_by": "a", "reasoning": true, "supported_reasoning_levels": reportLevels("max", "low", "high")},
			map[string]any{"id": "a/image", "owned_by": "a", "reasoning": false},
		}})
	}))
	defer up.Close()
	s := fixture(t)
	if err := s.Configure(Config{GatewayURL: up.URL, GatewayKey: "fixture", DailyLimit: 120}); err != nil {
		t.Fatal(err)
	}
	s.SetTarget("a/solo", true)
	s.SetTarget("a/gone", true)
	h := s.Handler("control")
	r := httptest.NewRequest("POST", "/api/effort/discover", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer control")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"updated":1`) || !strings.Contains(w.Body.String(), "a/gone") {
		t.Fatal(w.Body.String())
	}
	state, _ := s.Snapshot()
	if got := strings.Join(state.Targets["a/solo"].Levels, ","); got != "low,high,max" {
		t.Fatalf("levels not normalized: %s", got)
	}
	if state.Targets["a/solo"].Reasoning == nil || !*state.Targets["a/solo"].Reasoning {
		t.Fatal("reasoning flag lost")
	}
}

func TestEffortEndpointValidatesInput(t *testing.T) {
	s := fixture(t)
	s.SetTarget("a/solo", true)
	h := s.Handler("control")
	post := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/effort", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer control")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := post(`{"model":"a/solo","effort":"xhigh"}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	state, _ := s.Snapshot()
	if state.Targets["a/solo"].Effort != "xhigh" {
		t.Fatal("effort not persisted")
	}
	if w := post(`{"model":"a/solo","effort":"nonsense"}`); w.Code != 400 {
		t.Fatal("invalid effort accepted", w.Code)
	}
	if w := post(`{"model":"","effort":"max"}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	state, _ = s.Snapshot()
	if state.Config.Effort != "max" {
		t.Fatal("global default not persisted")
	}
	// The default must survive a config save that omits the field.
	if err := s.Configure(Config{GatewayURL: "http://127.0.0.1:3425", GatewayKey: "k", DailyLimit: 120, Effort: "MAX"}); err != nil {
		t.Fatal(err)
	}
	state, _ = s.Snapshot()
	if state.Config.Effort != "max" {
		t.Fatalf("config effort not normalized: %q", state.Config.Effort)
	}
}

func TestReasoningOnlyTruncationIsReported(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": ""}, "finish_reason": "length"}},
			"usage":   map[string]any{"total_tokens": 8192, "completion_tokens_details": map[string]int{"reasoning_tokens": 8000}},
		})
	}))
	defer up.Close()
	_, _, _, err := call(t.Context(), Config{GatewayURL: up.URL, GatewayKey: "k"}, "a/solo", "q", "max", nil)
	if err == nil || !strings.Contains(err.Error(), "思考") || !strings.Contains(err.Error(), "length") {
		t.Fatal("reasoning-only truncation not explained", err)
	}
}

func TestOutputBudgetScalesWithEffort(t *testing.T) {
	for _, tt := range []struct {
		effort string
		want   int
	}{{"", 24576}, {"low", 24576}, {"medium", 24576}, {"high", 32768}, {"xhigh", 65536}, {"max", 65536}, {"ultra", 65536}} {
		if got := OutputBudget(tt.effort); got != tt.want {
			t.Fatalf("%q: got %d want %d", tt.effort, got, tt.want)
		}
	}
	// Measured milk probes exceeded 8192 reasoning tokens at every level, so no
	// budget may sit at or below the old fixed cap.
	for _, level := range append([]string{""}, EffortLevels...) {
		if OutputBudget(level) <= 8192 {
			t.Fatalf("%q: budget %d cannot fit a probe that reasons", level, OutputBudget(level))
		}
	}
}

func TestProbeTimeoutScalesWithEffort(t *testing.T) {
	for _, tt := range []struct {
		effort string
		want   time.Duration
	}{{"", 240 * time.Second}, {"low", 240 * time.Second}, {"high", 360 * time.Second}, {"max", 540 * time.Second}, {"ultra", 540 * time.Second}} {
		if got := ProbeTimeout(tt.effort); got != tt.want {
			t.Fatalf("%q: got %s want %s", tt.effort, got, tt.want)
		}
	}
	// The HTTP client timeout must never fire before a level's own deadline.
	for _, level := range append([]string{""}, EffortLevels...) {
		if client.Timeout < ProbeTimeout(level) {
			t.Fatalf("%q: client timeout %s is below the probe deadline %s", level, client.Timeout, ProbeTimeout(level))
		}
	}
}

func TestCallSendsScaledMaxTokens(t *testing.T) {
	var got int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MaxTokens int `json:"max_tokens"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		got = body.MaxTokens
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": "46.24 inches"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"total_tokens": 10},
		})
	}))
	defer up.Close()
	if _, _, _, err := call(t.Context(), Config{GatewayURL: up.URL, GatewayKey: "k"}, "a/solo", "q", "max", nil); err != nil {
		t.Fatal(err)
	}
	if got != 65536 {
		t.Fatalf("max_tokens not scaled: %d", got)
	}
}

func TestNormalizeLevelsOrdersWeakToStrong(t *testing.T) {
	got := NormalizeLevels([]string{"max", "low", "high", "low", "bogus", " medium "})
	if strings.Join(got, ",") != "low,medium,high,max" {
		t.Fatalf("got %v", got)
	}
	if len(NormalizeLevels(nil)) != 0 {
		t.Fatal("nil produced levels")
	}
}

func TestEffortChangeKeepsBudgetDayCount(t *testing.T) {
	s := fixture(t)
	s.SetTarget("a/solo", true)
	s.mu.Lock()
	s.state.Config = Config{GatewayURL: "http://127.0.0.1:1", GatewayKey: "fixture", DailyLimit: 1}
	s.state.Results = append(s.state.Results, Result{ID: "x", Model: "a/solo", Time: time.Now(), Answer: "old", Effort: "low"})
	s.mu.Unlock()
	if err := s.SetEffort("a/solo", "high"); err != nil {
		t.Fatal(err)
	}
	if err := s.Trigger("a/solo", "milk", true); err == nil || !strings.Contains(err.Error(), "预算") {
		t.Fatal("effort change reset the daily budget", err)
	}
}
