package check

import (
	"os/exec"
	"testing"
	"time"
)

func TestGateTimeBoundaries(t *testing.T) {
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("Bun unavailable")
	}
	for _, tc := range []struct {
		name, state    string
		checked, allow time.Time
		blocked        bool
	}{
		{"fresh", "passed", time.Now(), time.Time{}, false},
		{"expired", "passed", time.Now().Add(-16 * time.Minute), time.Time{}, true},
		{"lease", "review", time.Time{}, time.Now().Add(time.Minute), false},
		{"lease expired", "review", time.Time{}, time.Now().Add(-time.Second), true},
		{"checking", "checking", time.Time{}, time.Time{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := fixture(t)
			s.SetTarget("a/solo", true)
			s.mu.Lock()
			s.state.Config.GateMode = "strict"
			target := s.state.Targets["a/solo"]
			target.State = tc.state
			target.CheckedAt = tc.checked
			target.AllowUntil = tc.allow
			if err := s.saveLocked(); err != nil {
				t.Fatal(err)
			}
			s.mu.Unlock()
			script := `const m=await import(process.argv[1]);let blocked=false;m.onRequest({model:"a/solo"},{reject:s=>{if(s!==403)throw Error("wrong status");blocked=true}});if(blocked!==` + map[bool]string{true: "true", false: "false"}[tc.blocked] + `)throw Error("wrong gate decision");`
			if out, err := exec.Command("bun", "-e", script, s.gate).CombinedOutput(); err != nil {
				t.Fatalf("%s: %v", out, err)
			}
		})
	}
}
