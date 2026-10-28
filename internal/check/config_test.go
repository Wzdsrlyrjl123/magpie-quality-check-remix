package check

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInitialConfigPreservesManualAndRetainsKey(t *testing.T) {
	s := fixture(t)
	manual := Config{GatewayURL: "https://manual.example/v1", GatewayKey: "private-key", DailyLimit: 45, GateMode: "observe"}
	if err := s.Configure(manual); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureInitial(Config{GatewayURL: "http://127.0.0.1:3425", GatewayKey: "magpie", DailyLimit: 120, Effort: "max"}); err != nil {
		t.Fatal(err)
	}
	if s.state.Config != manual {
		t.Fatal("discovery overwrote manual config")
	}
	manual.GatewayKey = ""
	manual.DailyLimit = 50
	if err := s.Configure(manual); err != nil {
		t.Fatal(err)
	}
	if s.state.Config.GatewayKey != "private-key" {
		t.Fatal("blank form cleared key")
	}
}

func TestInitialConfigAcceptsEffortAndRejectsBadOption(t *testing.T) {
	s := fixture(t)
	if err := s.ConfigureInitial(Config{GatewayURL: "http://127.0.0.1:3425", GatewayKey: "magpie", DailyLimit: 120, Effort: " High "}); err != nil {
		t.Fatal(err)
	}
	if s.state.Config.Effort != "high" {
		t.Fatalf("effort not normalized: %q", s.state.Config.Effort)
	}

	// A malformed plugin option must not stop discovery from connecting.
	other := fixture(t)
	if err := other.ConfigureInitial(Config{GatewayURL: "http://127.0.0.1:3425", GatewayKey: "magpie", DailyLimit: 120, Effort: "nonsense"}); err != nil {
		t.Fatal(err)
	}
	if other.state.Config.GatewayURL == "" || other.state.Config.Effort != "" {
		t.Fatalf("bad option not dropped: %+v", other.state.Config)
	}
}

func TestConfigRequiresKeyAndStateRedactsIt(t *testing.T) {
	s := fixture(t)
	cfg := Config{GatewayURL: "http://127.0.0.1:3425", DailyLimit: 120}
	if s.Configure(cfg) == nil {
		t.Fatal("accepted missing key")
	}
	h := s.Handler("control")
	state := func() map[string]any {
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.Header.Set("Authorization", "Bearer control")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var value map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(w.Body.String(), "unique-private-key") {
			t.Fatal("key exposed")
		}
		return value
	}
	if state()["gateway_configured"] != false {
		t.Fatal("missing config reported ready")
	}
	cfg.GatewayKey = "unique-private-key"
	if err := s.Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if state()["gateway_configured"] != true {
		t.Fatal("configured flag missing")
	}
}

func TestConnectionCheckAndInitialControlOnly(t *testing.T) {
	s := fixture(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer private-key" {
			t.Error("invalid gateway check")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"a/solo"}]}`))
	}))
	defer up.Close()
	a := NewAccess("control", "http://example.com")
	session, _ := a.Exchange(a.Ticket())
	h := s.ManagedHandler(a, nil)
	r := httptest.NewRequest("POST", "/api/config/initial", strings.NewReader(`{}`))
	r.AddCookie(&http.Cookie{Name: "quality_session", Value: session})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("browser can initialize config", w.Code)
	}
	cfg := Config{GatewayURL: up.URL, GatewayKey: "private-key", DailyLimit: 120}
	body, _ := json.Marshal(cfg)
	r = httptest.NewRequest("POST", "/api/config/initial", strings.NewReader(string(body)))
	r.Header.Set("Authorization", "Bearer control")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	r = httptest.NewRequest("POST", "/api/connection/check", strings.NewReader(`{}`))
	r.AddCookie(&http.Cookie{Name: "quality_session", Value: session})
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"model_count":1`) {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, asset := range []string{"/assets/app.js", "/assets/app.css", "/assets/icon.png", "/assets/fonts/space-mono-regular.ttf"} {
		r = httptest.NewRequest("GET", asset, nil)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal("public asset", asset)
		}
		r.AddCookie(&http.Cookie{Name: "quality_session", Value: session})
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || w.Body.Len() == 0 {
			t.Fatal("asset missing", asset, w.Code)
		}
	}
}
