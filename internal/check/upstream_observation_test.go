package check

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeObservation(t *testing.T, dir, id string, r upstreamObservation) {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}
func sampleObservation(id string, now time.Time) upstreamObservation {
	return upstreamObservation{Schema: 1, ResponseID: id, Provider: "qoder", SentModel: "actual-sent", ResponseModel: "raw-upstream", Models: []string{"raw-upstream"}, Source: observationSource, CapturedAt: now.Format(time.RFC3339Nano)}
}
func TestObservationValidation(t *testing.T) {
	now := time.Now()
	id := "response_123"
	dir := t.TempDir()
	cases := []struct {
		name   string
		mutate func(*upstreamObservation)
		status string
	}{
		{"valid", func(r *upstreamObservation) {}, "observed"},
		{"no model", func(r *upstreamObservation) { r.Models = nil; r.ResponseModel = "" }, "not_returned"},
		{"conflict", func(r *upstreamObservation) { r.Models = append(r.Models, "other") }, "observed"},
		{"expired", func(r *upstreamObservation) { r.CapturedAt = now.Add(-11 * time.Minute).Format(time.RFC3339Nano) }, "not_captured"},
		{"early", func(r *upstreamObservation) { r.CapturedAt = now.Add(-31 * time.Second).Format(time.RFC3339Nano) }, "not_captured"},
		{"future", func(r *upstreamObservation) { r.CapturedAt = now.Add(31 * time.Second).Format(time.RFC3339Nano) }, "not_captured"},
		{"provider", func(r *upstreamObservation) { r.Provider = "other" }, "not_captured"},
		{"id", func(r *upstreamObservation) { r.ResponseID = "other" }, "not_captured"},
		{"source", func(r *upstreamObservation) { r.Source = "other" }, "not_captured"},
		{"schema", func(r *upstreamObservation) { r.Schema = 2 }, "not_captured"},
		{"duplicate", func(r *upstreamObservation) { r.Models = append(r.Models, "raw-upstream") }, "not_captured"},
		{"too many", func(r *upstreamObservation) {
			for i := 0; i < 16; i++ {
				r.Models = append(r.Models, fmt.Sprint(i))
			}
		}, "not_captured"},
		{"long model", func(r *upstreamObservation) {
			r.ResponseModel = strings.Repeat("x", 201)
			r.Models = []string{r.ResponseModel}
		}, "not_captured"},
		{"missing from list", func(r *upstreamObservation) { r.ResponseModel = "different" }, "not_captured"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := sampleObservation(id, now)
			tc.mutate(&r)
			writeObservation(t, dir, id, r)
			out := RouteCheck{ResponseID: id, Provider: "qoder", UpstreamStatus: "not_captured"}
			applyUpstreamObservation(&out, dir, now, now)
			if out.UpstreamStatus != tc.status {
				t.Fatalf("got %+v", out)
			}
			if tc.name == "conflict" && !out.UpstreamConflict {
				t.Fatal("expected conflict")
			}
		})
	}
	for _, bad := range []string{"../escape", strings.Repeat("a", 161), "", "a/b"} {
		out := RouteCheck{ResponseID: bad, Provider: "qoder", UpstreamStatus: "not_captured"}
		applyUpstreamObservation(&out, dir, now, now)
		if out.UpstreamStatus != "not_captured" {
			t.Fatal(bad)
		}
	}
	for _, raw := range []string{"{bad", strings.Repeat("x", maxObservationBytes+1)} {
		if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		out := RouteCheck{ResponseID: id, Provider: "qoder", UpstreamStatus: "not_captured"}
		applyUpstreamObservation(&out, dir, now, now)
		if out.UpstreamStatus != "not_captured" {
			t.Fatal(out)
		}
	}
}
func TestProbeObservationAndFallback(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeObservation(t, dir, "resp1", sampleObservation("resp1", now))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.Messages[0].Content != routePrompt {
			t.Error("wrong prompt")
		}
		if strings.HasPrefix(body.Model, "quality-probe/") {
			w.WriteHeader(404)
			fmt.Fprintf(w, `{"error":{"message":%q}}`, body.Model)
			return
		}
		w.Header().Set("X-Magpie-Provider", "qoder")
		w.Header().Set("X-Magpie-Model", "gateway-route")
		fmt.Fprint(w, `{"id":"resp1","model":"gateway-body","choices":[{"message":{"content":"OK"}}]}`)
	}))
	defer server.Close()
	got := probeRouteWithObservations(context.Background(), Config{GatewayURL: server.URL}, "quality-probe/a/model", "model", "", dir)
	if !got.Direct || got.Served != "gateway-route" || got.BodyModel != "gateway-body" || got.UpstreamModel != "raw-upstream" || got.UpstreamSentModel != "actual-sent" || got.UpstreamStatus != "observed" {
		t.Fatalf("%+v", got)
	}
	if err := os.Remove(filepath.Join(dir, "resp1.json")); err != nil {
		t.Fatal(err)
	}
	got = probeRouteWithObservations(context.Background(), Config{GatewayURL: server.URL}, "quality-probe/a/model", "model", "", dir)
	if got.UpstreamStatus != "not_captured" || got.UpstreamModel != "" {
		t.Fatalf("must not infer: %+v", got)
	}
}
func TestOldRouteJSONCompatibility(t *testing.T) {
	var old RouteCheck
	if err := json.Unmarshal([]byte(`{"id":"old","model":"m","served":"s","self_claim":"old answer"}`), &old); err != nil {
		t.Fatal(err)
	}
	if old.UpstreamStatus != "" || old.UpstreamModel != "" || old.SelfClaim != "old answer" {
		t.Fatalf("%+v", old)
	}
}

func TestCheckRouteReadsServiceObservationDir(t *testing.T) {
	dir := t.TempDir()
	observationDir := filepath.Join(dir, "upstream-observations")
	if err := os.Mkdir(observationDir, 0700); err != nil {
		t.Fatal(err)
	}
	server := newGatewayStub(t, func(w http.ResponseWriter) {
		writeObservation(t, observationDir, "service-id", sampleObservation("service-id", time.Now()))
		w.Header().Set("X-Magpie-Provider", "qoder")
		fmt.Fprint(w, `{"id":"service-id","model":"gateway"}`)
	})
	s, err := New(dir, filepath.Join(dir, "gate.js"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Configure(Config{GatewayURL: server, GatewayKey: "key", DailyLimit: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckRoute("qoder/model", ""); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		state, _ := s.Snapshot()
		if len(state.Routes) == 1 {
			if state.Routes[0].UpstreamModel != "raw-upstream" {
				t.Fatalf("%+v", state.Routes[0])
			}
			if err := s.CheckRoute("qoder/model", ""); err == nil {
				t.Fatal("route must count toward daily budget")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}
