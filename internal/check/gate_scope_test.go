package check

import (
	"encoding/json"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGateModesAndHarnessScope(t *testing.T) {
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("Bun unavailable")
	}
	for _, tc := range []struct {
		name, mode, agents, caller, state string
		blocked, trigger                  bool
	}{
		{"default observes", "", "", "pi", "unverified", false, true},
		{"observe while checking", "observe", "", "codex", "checking", false, false},
		{"observe failed", "observe", "", "claude", "review", false, false},
		{"observe unavailable", "observe", "", "pi", "unavailable", false, true},
		{"strict selected", "strict", "pi,codex", "pi", "unverified", true, true},
		{"strict other harness", "strict", "pi", "codex", "review", false, false},
		{"strict unknown caller excluded", "strict", "pi", "", "unverified", false, false},
		{"strict all callers", "strict", "", "", "review", true, false},
		{"scope uses exact identity", "strict", "pi", "pi-other", "unverified", false, false},
		{"scope normalizes case", "strict", " PI，Codex,pi ", "CODEX", "review", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := fixture(t)
			if err := s.Configure(Config{GatewayURL: "http://127.0.0.1:1", GatewayKey: "fixture", DailyLimit: 120, GateMode: tc.mode, GateAgents: tc.agents}); err != nil {
				t.Fatal(err)
			}
			s.SetTarget("a/solo", true)
			s.mu.Lock()
			s.state.Targets["a/solo"].State = tc.state
			if err := s.saveLocked(); err != nil {
				t.Fatal(err)
			}
			alias := s.state.Alias
			s.mu.Unlock()
			options, _ := json.Marshal(map[string]any{"caller": tc.caller, "blocked": tc.blocked, "trigger": tc.trigger, "alias": alias})
			script := `const m=await import(process.argv[1]);const o=JSON.parse(process.argv[2]);
let rejected=false,logs=[];console.log=(v)=>logs.push(v);
const body={model:"a/solo",messages:[{role:"user",content:"business"}]};
const result=m.onRequest(body,{agent:o.caller,reject:(status,message)=>{if(status!==403||!message.includes("MAGPIE_QUALITY_REVIEW_REQUIRED"))throw Error("wrong error");rejected=true}});
if(rejected!==o.blocked)throw Error("wrong decision");
if(!rejected&&result!==body)throw Error("business body changed");
if(logs.some(v=>v.startsWith("MAGPIE_QUALITY_TRIGGER "))!==o.trigger)throw Error("wrong trigger");
const fail=()=>{throw Error("probe or unmonitored target blocked")};
const probe=m.onRequest({model:"quality-probe/"+o.alias+"/a/solo"},{agent:"outside-scope",reject:fail});
if(probe.model!=="a/solo")throw Error("probe alias not resolved before scope filter");
m.onRequest({model:"a/other"},{agent:o.caller,reject:fail});`
			if out, err := exec.Command("bun", "-e", script, s.gate, string(options)).CombinedOutput(); err != nil {
				t.Fatalf("%s: %v", out, err)
			}
		})
	}
}

func TestGateConfigValidationAndPersistence(t *testing.T) {
	s := fixture(t)
	for _, body := range []string{
		`{"gateway_url":"http://127.0.0.1:1","gateway_key":"fixture","daily_limit":120,"gate_mode":"offf"}`,
		`{"gateway_url":"http://127.0.0.1:1","gateway_key":"fixture","daily_limit":120,"gate_agents":"pi/*"}`,
	} {
		r := httptest.NewRequest("POST", "/api/config", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer control")
		w := httptest.NewRecorder()
		s.Handler("control").ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid gate config: %d %s", w.Code, w.Body.String())
		}
	}
	if err := s.Configure(Config{GatewayURL: "http://127.0.0.1:1", GatewayKey: "fixture", DailyLimit: 120, GateMode: " STRICT ", GateAgents: " PI，codex,pi "}); err != nil {
		t.Fatal(err)
	}
	var restored State
	if err := s.store.Load(&restored); err != nil {
		t.Fatal(err)
	}
	if restored.Config.GateMode != "strict" || restored.Config.GateAgents != "pi,codex" {
		t.Fatalf("gate scope not persisted: %+v", restored.Config)
	}
}

func TestLegacyConfigDefaultsToObserve(t *testing.T) {
	dir := t.TempDir()
	gate := filepath.Join(dir, "gate.js")
	s, err := New(dir, gate)
	if err != nil {
		t.Fatal(err)
	}
	s.SetTarget("a/solo", true)
	s.state.Config.GateMode = ""
	if err := s.store.Save(s.state); err != nil {
		t.Fatal(err)
	}
	s.Close()
	restored, err := New(dir, gate)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	state, _ := restored.Snapshot()
	if state.Config.GateMode != "observe" || !state.Targets["a/solo"].Enabled {
		t.Fatal("legacy mode did not migrate without losing targets")
	}
}
