package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	store, err := OpenStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	srv := httptest.NewServer(newHandler(store))
	t.Cleanup(srv.Close)
	return srv
}

func do(t *testing.T, method, url, body string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp, []byte(sb.String())
}

func TestProjectLifecycle(t *testing.T) {
	srv := testServer(t)
	u := srv.URL + "/api/projects"

	resp, b := do(t, "POST", u, `{"name":"  Landing  "}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	var p Project
	json.Unmarshal(b, &p)
	if p.Name != "Landing" || p.ID == "" {
		t.Fatalf("bad project %+v", p)
	}

	// Update doc + rename.
	doc := `{"version":1,"root":{"id":"root","tag":"body","children":[{"id":"a","tag":"div"}]}}`
	resp, b = do(t, "PUT", u+"/"+p.ID, `{"name":"Renamed","doc":`+doc+`}`)
	if resp.StatusCode != 200 {
		t.Fatalf("update: %d %s", resp.StatusCode, b)
	}
	resp, b = do(t, "GET", u+"/"+p.ID, "")
	var got struct {
		Project Project
		Doc     json.RawMessage
	}
	json.Unmarshal(b, &got)
	if got.Project.Name != "Renamed" || !strings.Contains(string(got.Doc), `"id":"a"`) {
		t.Fatalf("get: %s", b)
	}

	// Duplicate then delete original.
	resp, b = do(t, "POST", u+"/"+p.ID+"/duplicate", "")
	var dup Project
	json.Unmarshal(b, &dup)
	if resp.StatusCode != 201 || dup.Name != "Renamed (copy)" {
		t.Fatalf("duplicate: %d %s", resp.StatusCode, b)
	}
	if resp, _ = do(t, "DELETE", u+"/"+p.ID, ""); resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "GET", u+"/"+p.ID, ""); resp.StatusCode != 404 {
		t.Fatalf("get deleted: %d", resp.StatusCode)
	}
	_, b = do(t, "GET", u, "")
	var list []Project
	json.Unmarshal(b, &list)
	if len(list) != 1 || list[0].ID != dup.ID {
		t.Fatalf("list: %s", b)
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	srv := testServer(t)
	u := srv.URL + "/api/projects"
	_, b := do(t, "POST", u, `{"name":"My Site"}`)
	var p Project
	json.Unmarshal(b, &p)

	resp, exp := do(t, "GET", u+"/"+p.ID+"/export", "")
	if cd := resp.Header.Get("Content-Disposition"); !strings.Contains(cd, "My-Site.figmore.json") {
		t.Fatalf("content-disposition: %q", cd)
	}
	resp, b = do(t, "POST", u+"/import", string(exp))
	if resp.StatusCode != 201 {
		t.Fatalf("import: %d %s", resp.StatusCode, b)
	}
	var imp Project
	json.Unmarshal(b, &imp)
	if imp.Name != "My Site" || imp.ID == p.ID {
		t.Fatalf("imported %+v", imp)
	}
}

func TestValidation(t *testing.T) {
	srv := testServer(t)
	u := srv.URL + "/api/projects"
	_, b := do(t, "POST", u, "")
	var p Project
	json.Unmarshal(b, &p)
	if p.Name != "Untitled project" {
		t.Fatalf("default name: %q", p.Name)
	}
	cases := []struct{ method, path, body string }{
		{"PUT", u + "/" + p.ID, `{"doc":{"nope":1}}`},
		{"PUT", u + "/" + p.ID, `{"name":"  "}`},
		{"PUT", u + "/" + p.ID, `not json`},
		{"POST", u + "/import", `{"format":"other"}`},
		{"POST", u + "/import", `{"format":"figmore-project","version":99,"doc":{"root":{"tag":"body"}}}`},
		{"POST", u + "/import", `{"format":"figmore-project","version":1,"doc":{}}`},
	}
	for _, c := range cases {
		if resp, body := do(t, c.method, c.path, c.body); resp.StatusCode != 400 {
			t.Errorf("%s %s %q: got %d %s, want 400", c.method, c.path, c.body, resp.StatusCode, body)
		}
	}
	if resp, _ := do(t, "PUT", u+"/missing", `{"name":"x"}`); resp.StatusCode != 404 {
		t.Errorf("missing project: %d", resp.StatusCode)
	}
}
