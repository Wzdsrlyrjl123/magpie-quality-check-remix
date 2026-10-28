package check

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// Port of ModelTrace's generate_challenges; scoring uses its unmodified JS.
func traceChoice(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err)
	}
	return int(v.Int64())
}

func traceChallenges() []Result {
	openings := []string{"这是一次独立的数值选择记录", "请完成下面的无语义整数选择任务", "执行一次第一反应取值记录", "生成一组不承载语义的整数选择", "进行一轮快速逐项取值"}
	actions := []string{"为各个位置分别凭第一反应选择", "逐项选择", "每次只决定当前一项，共给出", "分别凭第一反应给出", "逐个直接选择"}
	endings := []string{"允许某个数字再次出现；每项写出后不要回头排序、去重或替换。", "偶然重复是有效的；不要重新排列或修正已经写出的项目。", "相同值可以再次出现；输出过程中不要整理或改写前面的项目。", "重复值无需删除；不要筛选、重排或补成某种规律。", "不必赋予数字任何含义；已经给出的值保持不变。"}
	separators := []string{"数字之间用逗号或空格分隔均可。", "使用一种一致的常见分隔符即可。", "可以用逗号、空格或换行分隔。", "只要每个整数边界清楚，格式可自行选择。"}
	available := make([]int, 41)
	for i := range available {
		available[i] = 292 + i
	}
	batch := Secret()[:12]
	out := make([]Result, 3)
	for i := range out {
		index := traceChoice(len(available))
		count := available[index]
		available = append(available[:index], available[index+1:]...)
		prompt := fmt.Sprintf("%s。%s %d 个 1 到 355（含端点）的整数。", openings[traceChoice(len(openings))], actions[traceChoice(len(actions))], count) +
			"每个位置都要单独选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。" +
			"本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API 和外部随机数生成器；也不要先编写或运行代码。" +
			endings[traceChoice(len(endings))] + separators[traceChoice(len(separators))] +
			"直接从第一个取值开始输出，不要在序列前重复数量、范围或任务说明。"
		out[i] = Result{ID: Secret()[:12], Prompt: "modeltrace", Batch: batch, ExpectedCount: count, PromptText: prompt, Verdict: "running"}
	}
	return out
}

func (s *Service) TriggerModelTrace(model string) error {
	return s.TriggerModelTraceWithEffort(model, "")
}

// TriggerModelTraceWithEffort runs the fingerprint batch. The effort applies to
// every challenge in the batch so all three stay comparable.
func (s *Service) TriggerModelTraceWithEffort(model, effort string) error {
	level, err := ValidateEffort(effort)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.state.Targets[model]
	if t == nil {
		return errors.New("模型未配置")
	}
	if level == "" {
		level = s.effortFor(model)
	}
	if s.running[model] {
		return errors.New("该模型已有检测进行中，请完成后重试")
	}
	cfg := s.state.Config
	if cfg.GatewayURL == "" || cfg.GatewayKey == "" {
		return errors.New("请配置 Magpie 网关 URL 和 Key")
	}
	count := 0
	day := time.Now().UTC().Format("2006-01-02")
	count += s.state.ClearedUsage[day][model]
	for _, r := range s.state.Results {
		if r.Model == model && r.Time.UTC().Format("2006-01-02") == day {
			count++
		}
	}
	if count+3 > cfg.DailyLimit {
		return errors.New("ModelTrace 需要 3 次请求，今日剩余预算不足")
	}
	probes := traceChallenges()
	start := len(s.state.Results)
	for i := range probes {
		probes[i].Model = model
		probes[i].Time = time.Now()
		probes[i].Effort = level
	}
	s.state.Results = append(s.state.Results, probes...)
	if err := s.store.Save(s.state); err != nil {
		s.state.Results = s.state.Results[:start]
		return err
	}
	alias := s.state.Alias
	s.running[model] = true
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer func() { s.mu.Lock(); delete(s.running, model); s.mu.Unlock() }()
		for i, r := range probes {
			ctx, cancel := context.WithTimeout(s.ctx, ProbeTimeout(level))
			answer, tokens, reasoning, err := call(ctx, cfg, "quality-probe/"+alias+"/"+model, r.PromptText, level, nil)
			cancel()
			r.Answer, r.Tokens, r.ReasoningTokens, r.Verdict = answer, tokens, reasoning, "manual"
			if err != nil {
				r.Verdict, r.Error = "unavailable", err.Error()
			}
			s.mu.Lock()
			s.state.Results[start+i] = r
			if err := s.store.Save(s.state); err != nil {
				s.health = err.Error()
			}
			s.mu.Unlock()
		}
	}()
	return nil
}
