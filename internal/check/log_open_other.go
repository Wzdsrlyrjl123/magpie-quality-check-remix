//go:build !windows

package check

import "os"

func openLog(name string) (*os.File, error) { return os.Open(name) }
