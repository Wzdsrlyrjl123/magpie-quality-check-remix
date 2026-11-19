package check

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagedHandlerAllowsPluginPageWithoutLeakingControlSecret(t *testing.T) {
	dir := t.TempDir()
	service, err := New(dir, filepath.Join(dir, "gate.js"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	const control = "control-secret"
	access := NewAccess(control, "http://127.0.0.1:3489")
	handler := service.ManagedHandler(access, nil)
	server := httptest.NewServer(handler)
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/state", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "null")
	if response := mustDo(t, http.DefaultClient, request); response.StatusCode != http.StatusUnauthorized {
		response.Body.Close()
		t.Fatalf("unauthenticated API request status = %d, want %d", response.StatusCode, http.StatusUnauthorized)
	}

	prefix := server.URL + "/sidebar/" + access.SidebarToken()
	request, err = http.NewRequest(http.MethodGet, prefix+"/api/state", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "null")
	response := mustDo(t, http.DefaultClient, request)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("plugin page API request status = %d, want %d", response.StatusCode, http.StatusOK)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), control) {
		t.Fatal("plugin page API response leaked control secret")
	}

	request, err = http.NewRequest(http.MethodGet, prefix+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	response = mustDo(t, http.DefaultClient, request)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("plugin page status = %d, want %d", response.StatusCode, http.StatusOK)
	}
	if !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'self'") {
		t.Fatal("plugin page does not allow embedding by Magpie")
	}

	request, err = http.NewRequest(http.MethodPost, prefix+"/api/config/initial", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "null")
	response = mustDo(t, http.DefaultClient, request)
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("plugin page can access control-only API: status = %d", response.StatusCode)
	}
}

func mustDo(t *testing.T, client *http.Client, request *http.Request) *http.Response {
	t.Helper()
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
