package check

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

// Tail only new complete lines. Reopening handles renamed or truncated logs.
func (s *Service) WatchLog() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		var file *os.File
		var offset int64
		var current string
		var pending string
		defer func() {
			if file != nil {
				file.Close()
			}
		}()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-ticker.C:
				s.mu.Lock()
				name := s.state.Config.LogPath
				s.mu.Unlock()
				if name == "" {
					continue
				}
				info, err := os.Stat(name)
				if err != nil {
					continue
				}
				reopen := name != current || file == nil
				if file != nil {
					old, e := file.Stat()
					if e != nil || !os.SameFile(old, info) {
						reopen = true
					}
				}
				if reopen {
					initial := current != name
					if file != nil {
						file.Close()
					}
					file, err = openLog(name)
					if err != nil {
						file = nil
						continue
					}
					current = name
					offset = 0
					if initial {
						offset = info.Size()
					}
					pending = ""
				}
				if info.Size() < offset {
					offset = 0
					pending = ""
				}
				file.Seek(offset, io.SeekStart)
				reader := bufio.NewReader(io.LimitReader(file, 1024*1024))
				for {
					line, e := reader.ReadString('\n')
					offset += int64(len(line))
					pending += line
					if strings.HasSuffix(pending, "\n") {
						s.LogLine(pending)
						pending = ""
					}
					if len(pending) > 4096 {
						pending = ""
					}
					if e != nil {
						break
					}
				}
			}
		}
	}()
}
func (s *Service) LogLine(line string) {
	const marker = "MAGPIE_QUALITY_TRIGGER "
	i := strings.Index(line, marker)
	if i < 0 {
		return
	}
	var item struct {
		Model string `json:"model"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(line[i+len(marker):])), &item) != nil {
		return
	}
	s.mu.Lock()
	if target := s.state.Targets[item.Model]; target != nil && target.Enabled {
		s.lastActivity = time.Now()
	}
	s.mu.Unlock()
	_ = s.Trigger(item.Model, "milk", false)
}
