import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

// =========================================================
// Nano Banana Pro · Tutorial widgets
// Ported from the Claude Design handoff bundle (Tutorial Widgets.html).
// Single-page-light-theme variant of the original design.
//
// Exposes <TutorialTrigger page="Create" /> which:
//  - renders a "教程" button inline where it's placed;
//  - auto-opens once the first time the user visits that page
//    (tracked in localStorage key nbp_tutorial_seen_v1);
//  - lets users re-open the tutorial as often as they want.
// =========================================================

export type TutorialPage = "Create" | "Batch" | "History" | "Picker";

const STORAGE_KEY = "nbp_tutorial_seen_v1";

function readSeen(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeSeen(next: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / privacy mode — ignore silently so the tutorial never breaks the page.
  }
}

function markSeen(page: TutorialPage) {
  const current = readSeen();
  if (current[page]) return;
  current[page] = true;
  writeSeen(current);
}

// -----------------------------
// Tiny shared visual atoms
// -----------------------------

function Logo({ size = 22 }: { size?: number }) {
  return (
    <div className="inline-flex items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-full bg-[#f5c518]" />
        <div className="absolute inset-[3px] rounded-full border-[2px] border-black/80" />
      </div>
      <span className="font-semibold tracking-tight text-zinc-900">Nano Banana Pro</span>
    </div>
  );
}

type ChipTone = "slate" | "banana" | "dark" | "success" | "danger";

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: ChipTone }) {
  const tones: Record<ChipTone, string> = {
    slate: "bg-zinc-100 text-zinc-700 border-zinc-200",
    banana: "bg-[#fff8dc] text-[#7a5a00] border-[#f5c518]/40",
    dark: "bg-zinc-900 text-white border-zinc-900",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    danger: "bg-rose-50 text-rose-700 border-rose-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Dot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block rounded-full transition-all ${
        active ? "h-[6px] w-6 bg-zinc-900" : "h-[6px] w-[6px] bg-zinc-300"
      }`}
    />
  );
}

function MiniField({
  label,
  children,
  highlight,
}: {
  label: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl p-3 transition-all ${
        highlight
          ? "bg-[#fffdf3] ring-2 ring-[#f5c518]"
          : "border border-zinc-200 bg-white"
      }`}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-400">{label}</div>
      {children}
    </div>
  );
}

function PromptCaret({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    let v = 0;
    let holdAt = -1;
    const id = window.setInterval(() => {
      if (v >= text.length) {
        if (holdAt < 0) holdAt = Date.now();
        if (Date.now() - holdAt >= 2000) {
          v = 0;
          holdAt = -1;
          setN(0);
        }
        return;
      }
      v += 1;
      setN(v);
    }, 140);
    return () => window.clearInterval(id);
  }, [text]);
  return (
    <div className="text-[14px] font-medium leading-relaxed text-zinc-900">
      {text.slice(0, n)}
      <span className="ml-[1px] inline-block h-[16px] w-[7px] align-[-3px] animate-pulse bg-zinc-900" />
    </div>
  );
}

function Slider({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-zinc-500">{label}</span>
        <span className="font-mono font-semibold">{value.toFixed(2)}</span>
      </div>
      <div className="relative h-[5px] rounded-full bg-zinc-200">
        <motion.div
          className="absolute left-0 top-0 bottom-0 rounded-full bg-[#f5c518]"
          animate={{ width: `${value * 100}%` }}
          transition={{ duration: 0.6 }}
        />
        <motion.div
          className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-zinc-900 bg-white"
          animate={{ left: `calc(${value * 100}% - 6px)` }}
          transition={{ duration: 0.6 }}
        />
      </div>
    </div>
  );
}

function MiniSelect({ value }: { value: string }) {
  return (
    <div className="flex h-9 items-center justify-between rounded-md border border-zinc-200 bg-white px-3 text-[13px]">
      <span className="font-medium text-zinc-900">{value}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M1 3l4 4 4-4" />
      </svg>
    </div>
  );
}

type ImgVariant =
  | "yellow"
  | "amber"
  | "code"
  | "peel"
  | "sunset"
  | "ocean"
  | "mint"
  | "rose";

function ImgTile({
  label,
  variant = "yellow",
  selected,
  rank,
  delay = 0,
  fill,
}: {
  label?: string;
  variant?: ImgVariant;
  selected?: boolean;
  rank?: string;
  delay?: number;
  fill?: boolean;
}) {
  const grad: Record<ImgVariant, string> = {
    yellow: "linear-gradient(135deg,#fde68a,#f5c518)",
    amber: "linear-gradient(135deg,#fbbf24,#b45309)",
    code: "linear-gradient(135deg,#334155,#0f172a)",
    peel: "linear-gradient(135deg,#fff2b8,#e5a00d)",
    sunset: "linear-gradient(135deg,#fca5a5,#c026d3)",
    ocean: "linear-gradient(135deg,#93c5fd,#1e40af)",
    mint: "linear-gradient(135deg,#a7f3d0,#059669)",
    rose: "linear-gradient(135deg,#fbcfe8,#be185d)",
  };
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, duration: 0.4 }}
      className={`relative overflow-hidden rounded-lg border border-zinc-200 ${fill ? "h-full w-full" : ""}`}
      style={fill ? { background: grad[variant] } : { aspectRatio: "4/3", background: grad[variant] }}
    >
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 75" preserveAspectRatio="xMidYMid meet">
        {variant === "code" ? (
          <g fill="#94a3b8" opacity="0.6">
            {Array.from({ length: 7 }).map((_, i) => (
              <rect key={i} x={12} y={12 + i * 7} width={30 + ((i * 13) % 40)} height={3} rx={1} />
            ))}
            {Array.from({ length: 6 }).map((_, i) => (
              <rect key={`b${i}`} x={12} y={40 + i * 5} width={20 + ((i * 17) % 50)} height={2} rx={1} opacity="0.7" />
            ))}
          </g>
        ) : (
          <g transform="translate(50 38)">
            <path
              d="M-22 -8 Q -18 18 15 20 Q 22 18 22 12 Q 14 14 5 8 Q -10 0 -22 -8 Z"
              fill="#fff"
              opacity="0.55"
            />
            <path d="M -22 -8 L -25 -14 L -20 -12 Z" fill="#2a1e00" opacity="0.4" />
          </g>
        )}
      </svg>
      {label ? (
        <div className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-[10px] font-bold text-white">
          {label}
        </div>
      ) : null}
      {rank ? (
        <div className="absolute right-1 top-1 rounded bg-[#f5c518] px-1.5 py-0.5 text-[9px] font-bold text-black">
          {rank}
        </div>
      ) : null}
      {selected ? (
        <div className="pointer-events-none absolute inset-0 rounded-lg ring-[3px] ring-[#f5c518]" />
      ) : null}
    </motion.div>
  );
}

function Stars({ n, max = 5, animate = false }: { n: number; max?: number; animate?: boolean }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <motion.svg
          key={i}
          width="11"
          height="11"
          viewBox="0 0 24 24"
          initial={animate ? { scale: 0 } : undefined}
          animate={animate ? { scale: i < n ? 1 : 0.8, opacity: i < n ? 1 : 0.3 } : undefined}
          transition={{ delay: 0.1 + i * 0.1 }}
          fill={i < n ? "#f5c518" : "#e4e4e7"}
        >
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
        </motion.svg>
      ))}
    </div>
  );
}

// -----------------------------
// CREATE tutorial visuals
// -----------------------------

const CreateStep1: React.FC = () => (
  <div className="absolute inset-0 flex items-center justify-center p-8">
    <div className="w-full max-w-[460px] space-y-3">
      <MiniField label="PROMPT" highlight>
        <PromptCaret text="赛博朋克夜雨下的女孩，电影感，柔焦，霓虹反射" />
      </MiniField>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />主体
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />风格
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />光照
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />镜头
        </span>
      </div>
    </div>
  </div>
);

const CreateStep2: React.FC = () => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let i = 0;
    const id = window.setInterval(() => {
      i = (i + 1) % 6;
      setCount(i);
    }, 900);
    return () => window.clearInterval(id);
  }, []);
  const tileColors = ["#fde68a", "#a7f3d0", "#bfdbfe", "#fbcfe8", "#ddd6fe"];
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8">
      <div className="w-full max-w-[480px]">
        <MiniField label="参考图  ·  最多 14 张">
          <div className="mt-1 grid grid-cols-5 gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: i < count ? 1 : 0.15, y: 0 }}
                transition={{ delay: i * 0.1 }}
                className="relative overflow-hidden rounded-md border border-zinc-200"
                style={{ aspectRatio: "1" }}
              >
                <div className="absolute inset-0" style={{ background: tileColors[i] }} />
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 40 40">
                  <circle cx="12" cy="14" r="3" fill="#fff" opacity="0.7" />
                  <path d="M4 36 L16 22 L24 28 L36 16 L36 40 L4 40 Z" fill="#fff" opacity="0.6" />
                </svg>
              </motion.div>
            ))}
          </div>
          <div className="mt-3 flex flex-col items-center rounded-lg border-2 border-dashed border-zinc-300 py-3 text-[12px] text-zinc-500">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.6">
              <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" />
            </svg>
            <span className="mt-1">拖拽或点击上传</span>
            <span className="mt-0.5 font-mono text-[10px] text-zinc-400">{count}/14</span>
          </div>
        </MiniField>
      </div>
    </div>
  );
};

const CreateStep3: React.FC = () => {
  const [t, setT] = useState(0.7);
  useEffect(() => {
    let v = 0.7;
    let up = true;
    const id = window.setInterval(() => {
      if (up) {
        v += 0.04;
        if (v >= 0.95) up = false;
      } else {
        v -= 0.04;
        if (v <= 0.35) up = true;
      }
      setT(v);
    }, 250);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8">
      <div className="w-full max-w-[480px] space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <MiniField label="MODEL">
            <MiniSelect value="Nano Banana Pro" />
          </MiniField>
          <MiniField label="ASPECT_RATIO">
            <MiniSelect value="16:9" />
          </MiniField>
          <MiniField label="IMAGE_SIZE">
            <MiniSelect value="2K" />
          </MiniField>
          <MiniField label="JOB_COUNT">
            <MiniSelect value="4" />
          </MiniField>
        </div>
        <MiniField label="TEMPERATURE" highlight>
          <Slider value={t} label="随机性" />
        </MiniField>
      </div>
    </div>
  );
};

const CreateStep4: React.FC = () => {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setPhase((p) => (p + 1) % 4), 900);
    return () => window.clearInterval(id);
  }, []);
  const pct = [20, 55, 85, 100][phase];
  const msg = ["QUEUED", "RUNNING · 排队 320ms", "RUNNING · 已 8.2s", "SUCCEEDED"][phase];
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8">
      <div className="w-full max-w-[480px]">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,.04),0_1px_3px_rgba(0,0,0,.06)]">
          <div className="mb-3 flex items-center gap-3">
            <div className="relative h-10 w-10">
              <div className="absolute inset-0 rounded-full border-[3px] border-zinc-200" />
              <svg className="absolute inset-0 -rotate-90" viewBox="0 0 40 40">
                <circle
                  cx={20}
                  cy={20}
                  r={17}
                  fill="none"
                  stroke="#f5c518"
                  strokeWidth={3}
                  strokeDasharray={`${pct * 1.07} 200`}
                  style={{ transition: "stroke-dasharray .5s" }}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] font-bold">
                {pct}%
              </div>
            </div>
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-zinc-900">生成中…</div>
              <div className="text-[11px] text-zinc-500">{msg}</div>
            </div>
            <Chip tone={phase === 3 ? "success" : "banana"}>{phase === 3 ? "SUCCEEDED" : "RUNNING"}</Chip>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((i) => (
              <motion.div
                key={i}
                className="relative overflow-hidden rounded-lg border border-zinc-200"
                style={{ aspectRatio: "4/3" }}
              >
                {phase < 3 ? (
                  <div className="nbp-tutorial-shimmer absolute inset-0" />
                ) : (
                  <div className="absolute inset-0" style={{ background: "linear-gradient(135deg,#fde68a,#e0a800)" }}>
                    <svg className="h-full w-full" viewBox="0 0 100 75">
                      <g transform="translate(50 38)">
                        <path
                          d="M-22 -8 Q -18 18 15 20 Q 22 18 22 12 Q 14 14 5 8 Q -10 0 -22 -8 Z"
                          fill="#fff"
                          opacity="0.7"
                        />
                      </g>
                    </svg>
                  </div>
                )}
                {phase === 3 ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                      <path d="M2 5l2 2 4-4" />
                    </svg>
                  </motion.div>
                ) : null}
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// -----------------------------
// BATCH tutorial visuals
// -----------------------------

type PptPage = { n: number; title: string; prompt: string; accent: string };

const PPT_PAGES: PptPage[] = [
  { n: 1, title: "封面", prompt: "品牌主视觉 · 极简 · 大留白", accent: "#f5c518" },
  { n: 2, title: "产品特性", prompt: "产品近景 · 柔光 · 干净背景", accent: "#10b981" },
  { n: 3, title: "数据对比", prompt: "抽象几何 · 品牌色数据卡", accent: "#3b82f6" },
  { n: 4, title: "用户案例", prompt: "人物使用场景 · 自然光", accent: "#8b5cf6" },
  { n: 5, title: "结束页", prompt: "尾屏 · 渐变 · 品牌 logo", accent: "#ef4444" },
];

function SlideThumb({
  n,
  title,
  accent,
  active,
  mini,
}: {
  n: number;
  title?: string;
  accent?: string;
  active?: boolean;
  mini?: boolean;
}) {
  const h = mini ? 36 : 54;
  return (
    <div className="relative overflow-hidden rounded border border-zinc-200 bg-white" style={{ height: h }}>
      <div
        className="absolute inset-0"
        style={{ background: active ? "linear-gradient(135deg,#fff,#fff7cf)" : "#ffffff" }}
      />
      <div className="absolute left-1 right-1 top-1 h-1 rounded-full" style={{ background: accent || "#e4e4e7" }} />
      <div className="absolute left-1 right-1 top-3 h-[3px] rounded-full bg-zinc-300" />
      <div className="absolute left-1 right-4 top-5 h-[2px] rounded-full bg-zinc-200" />
      <div className="absolute bottom-1 left-1 flex items-center gap-1">
        <span className="font-mono text-[9px] font-bold text-zinc-400">P{n}</span>
        {!mini && title ? (
          <span className="max-w-[70px] truncate text-[9px] text-zinc-500">{title}</span>
        ) : null}
      </div>
      {active ? (
        <div
          className="absolute inset-0 rounded ring-2 ring-[#f5c518]"
          style={{ boxShadow: "0 0 0 3px rgba(245,197,24,.2)" }}
        />
      ) : null}
    </div>
  );
}

const BatchStep1: React.FC = () => {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setPhase((p) => (p + 1) % 2), 2400);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="absolute inset-0 flex items-center justify-center p-5">
      <div className="w-full max-w-[600px]">
        <div className="mb-3 text-center">
          <div className="text-[12px] text-zinc-500">
            场景 · 产品发布会 PPT · 共 5 页 · 每页 3 张候选图
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-3">
          <motion.div
            animate={{ opacity: phase === 0 ? 1 : 0.45, scale: phase === 0 ? 1 : 0.97 }}
            className="rounded-xl border border-zinc-200 bg-white p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <Chip tone="slate">手动 · Create</Chip>
              <span className="font-mono text-[10px] text-rose-600">× 15 次</span>
            </div>
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <motion.div
                  key={i}
                  animate={phase === 0 ? { x: [0, -3, 0] } : {}}
                  transition={{ delay: i * 0.08, duration: 0.5, repeat: phase === 0 ? Infinity : 0, repeatDelay: 1.5 }}
                  className="flex items-center gap-1.5 text-[10px]"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded bg-zinc-100 font-mono text-zinc-500">
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate text-zinc-600">打开 → 填 prompt → 提交</span>
                  <span className="font-mono text-zinc-400">×3</span>
                </motion.div>
              ))}
            </div>
            <div className="mt-2 border-t border-zinc-100 pt-2 text-center text-[10px] text-zinc-500">
              重复 15 遍 · 易错 · 难归档
            </div>
          </motion.div>

          <div className="flex items-center justify-center">
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="#a1a1aa" strokeWidth="1.6">
              <path d="M4 13h18M15 6l7 7-7 7" />
            </svg>
          </div>

          <motion.div
            animate={{ opacity: phase === 1 ? 1 : 0.45, scale: phase === 1 ? 1 : 0.97 }}
            className="relative rounded-xl border-2 p-3"
            style={{ borderColor: phase === 1 ? "#f5c518" : "#e4e4e7", background: "#fffef7" }}
          >
            <div className="mb-2 flex items-center justify-between">
              <Chip tone="banana">Batch · 一次提交</Chip>
              <span className="font-mono text-[10px] text-emerald-700">× 1 次</span>
            </div>
            <div className="mb-2 grid grid-cols-5 gap-1">
              {PPT_PAGES.map((p) => (
                <SlideThumb key={p.n} n={p.n} title={p.title} accent={p.accent} mini />
              ))}
            </div>
            <motion.div
              animate={phase === 1 ? { scale: [1, 1.04, 1] } : {}}
              transition={{ duration: 1, repeat: phase === 1 ? Infinity : 0 }}
              className="mt-1 rounded-md bg-zinc-900 py-1.5 text-center text-[11px] font-semibold text-white"
            >
              ▸ 提交全部 (15 子任务)
            </motion.div>
            <div className="mt-2 border-t border-[#f5c518]/30 pt-2 text-center text-[10px] text-[#7a5a00]">
              自动拆分 · 自动归档 · 并行出图
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

const BatchStep2: React.FC = () => {
  const [dripping, setDripping] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setDripping((d) => !d), 1800);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-5">
      <div className="w-full max-w-[540px]">
        <div className="rounded-xl border-2 border-[#f5c518] bg-[#fffef7] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Chip tone="banana">BATCH</Chip>
              <span className="text-[13px] font-semibold text-zinc-900">产品发布-2026Q4</span>
            </div>
            <span className="font-mono text-[10px] text-zinc-500">5 pages · 15 jobs</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5">
              <div className="text-[9px] uppercase text-zinc-400">GLOBAL MODEL</div>
              <div className="font-mono text-[11px] font-semibold">Nano Banana Pro</div>
            </div>
            <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5">
              <div className="text-[9px] uppercase text-zinc-400">ASPECT</div>
              <div className="font-mono text-[11px] font-semibold">16:9</div>
            </div>
            <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5">
              <div className="text-[9px] uppercase text-zinc-400">STYLE PROMPT</div>
              <div className="truncate text-[11px] font-medium">极简 · 品牌黄</div>
            </div>
          </div>
        </div>
        <div className="relative flex justify-around py-1.5" style={{ height: 32 }}>
          {PPT_PAGES.map((p, i) => (
            <motion.div
              key={p.n}
              animate={dripping ? { y: [-4, 18, -4], opacity: [0, 1, 0] } : { y: -4, opacity: 0 }}
              transition={{ delay: i * 0.15, duration: 1.5, repeat: dripping ? Infinity : 0, repeatDelay: 0.5 }}
              className="h-1.5 w-1.5 rounded-full bg-[#f5c518]"
            />
          ))}
        </div>
        <div className="grid grid-cols-5 gap-2">
          {PPT_PAGES.map((p) => (
            <div key={p.n} className="space-y-1">
              <SlideThumb n={p.n} title={p.title} accent={p.accent} />
              <div className="text-center font-mono text-[9px] text-zinc-400">继承 global</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-center text-[11px] text-zinc-500">
          ① 一次配置全局 · ② 每页自动继承 · ③ 需要时再单独覆盖
        </div>
      </div>
    </div>
  );
};

const BatchStep3: React.FC = () => {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setActive((a) => (a + 1) % 5), 1500);
    return () => window.clearInterval(id);
  }, []);
  const p = PPT_PAGES[active];
  return (
    <div className="absolute inset-0 flex items-center justify-center p-5">
      <div className="grid w-full max-w-[580px] grid-cols-[190px_1fr] gap-4">
        <div className="space-y-1.5">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-400">PPT 页面</div>
          {PPT_PAGES.map((pg, i) => (
            <motion.div
              key={pg.n}
              animate={{
                background: i === active ? "#fffef7" : "#ffffff",
                borderColor: i === active ? "#f5c518" : "#e4e4e7",
                scale: i === active ? 1.02 : 1,
              }}
              className="flex items-center gap-2 rounded-md border px-2 py-1.5"
            >
              <span
                className="flex h-5 w-5 items-center justify-center rounded font-mono text-[10px] font-bold"
                style={{ background: pg.accent, color: "#fff" }}
              >
                {pg.n}
              </span>
              <span className="text-[11px] font-medium text-zinc-900">{pg.title}</span>
            </motion.div>
          ))}
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className="flex h-6 w-6 items-center justify-center rounded font-mono text-[11px] font-bold"
                style={{ background: p.accent, color: "#fff" }}
              >
                {p.n}
              </span>
              <span className="text-[12px] font-semibold text-zinc-900">SECTION · {p.title}</span>
            </div>
            <Chip tone="slate">job × 3</Chip>
          </div>
          <div className="min-h-[44px] rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5">
            <div className="mb-0.5 text-[9px] uppercase text-zinc-400">PER-PAGE PROMPT (覆盖全局)</div>
            <AnimatePresence mode="wait">
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-[12px] font-medium text-zinc-900"
              >
                {p.prompt}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="relative aspect-[4/3] overflow-hidden rounded-md border border-zinc-200"
              >
                <div
                  className="absolute inset-0"
                  style={{ background: `linear-gradient(135deg, ${p.accent}33, ${p.accent}88)` }}
                />
                <span className="absolute left-1 top-1 font-mono text-[9px] font-bold text-white/90">#{i + 1}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1 text-[10px] text-zinc-500">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="6" cy="6" r="5" />
              <path d="M6 3v3.5l2 1.2" />
            </svg>
            <span>每段独立 prompt · 其他参数可选择覆盖或继承</span>
          </div>
        </div>
      </div>
    </div>
  );
};

const BatchStep4: React.FC = () => {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    let v = 0;
    const id = window.setInterval(() => {
      v = v >= 5 ? 0 : v + 1;
      setRevealed(v);
    }, 600);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="w-full max-w-[540px]">
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-white">
          <span className="shrink-0 text-[9px] uppercase tracking-wider text-zinc-400">TEMPLATE</span>
          <div className="flex flex-wrap items-center gap-1 font-mono text-[12px]">
            <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-zinc-100">{"{{batch}}"}</span>
            <span className="text-zinc-500">-P</span>
            <span className="rounded bg-[#f5c518] px-1.5 py-0.5 text-black">{"{{page_no}}"}</span>
            <span className="text-zinc-500">-</span>
            <span className="rounded bg-emerald-500 px-1.5 py-0.5 text-white">{"{{section}}"}</span>
          </div>
        </div>
        <div className="space-y-1">
          {PPT_PAGES.map((p, i) => (
            <motion.div
              key={p.n}
              animate={{
                opacity: i < revealed ? 1 : 0.25,
                x: i < revealed ? 0 : -6,
                borderColor: i === revealed - 1 ? "#f5c518" : "#e4e4e7",
                background: i === revealed - 1 ? "#fffef7" : "#ffffff",
              }}
              className="flex items-center gap-2 rounded-md border px-2 py-1"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="#a1a1aa"
                strokeWidth="1.4"
                className="shrink-0"
              >
                <path d="M2 4h4l2 2h6v7H2z" />
              </svg>
              <span className="flex-1 truncate font-mono text-[11px]">
                <span className="text-zinc-500">产品发布-2026Q4</span>
                <span className="text-zinc-400">-P</span>
                <span className="rounded bg-[#fff7cf] px-1 font-semibold text-[#7a5a00]">{p.n}</span>
                <span className="text-zinc-400">-</span>
                <span className="font-semibold text-emerald-700">{p.title}</span>
              </span>
              <Chip tone={i < revealed ? "success" : "slate"}>{i < revealed ? "已创建" : "待渲染"}</Chip>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
};

const BatchStep5: React.FC = () => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t >= 24 ? 0 : t + 1)), 260);
    return () => window.clearInterval(id);
  }, []);
  const sectionProgress = PPT_PAGES.map((_, i) => {
    const start = i * 1.8;
    return Math.max(0, Math.min(3, Math.floor((tick - start) * 0.45)));
  });
  const totalDone = sectionProgress.reduce((a, b) => a + b, 0);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-[560px]">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-[#f5c518]">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="#000">
                <path d="M6 4l14 8-14 8z" />
              </svg>
            </div>
            <span className="text-[12px] font-semibold text-zinc-900">提交 · 并行执行</span>
          </div>
          <span className="font-mono text-[11px] text-zinc-500">{totalDone}/15 完成</span>
        </div>
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-200">
          <motion.div
            animate={{ width: `${(totalDone / 15) * 100}%` }}
            className="h-full"
            style={{ background: "linear-gradient(90deg,#f5c518,#10b981)" }}
          />
        </div>
        <div className="space-y-1">
          {PPT_PAGES.map((p, i) => {
            const done = sectionProgress[i];
            const running = done < 3 && tick >= i * 1.8;
            return (
              <div key={p.n} className="flex items-center gap-2">
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[9px] font-bold"
                  style={{ background: p.accent, color: "#fff" }}
                >
                  {p.n}
                </span>
                <span className="w-[60px] truncate text-[11px] font-medium text-zinc-900">{p.title}</span>
                <div className="flex flex-1 gap-1">
                  {[0, 1, 2].map((k) => {
                    const isDone = k < done;
                    const isRun = k === done && running;
                    return (
                      <motion.div
                        key={k}
                        animate={{
                          background: isDone ? "#10b981" : isRun ? "#3b82f6" : "#e4e4e7",
                          scale: isRun ? [1, 1.05, 1] : 1,
                        }}
                        transition={isRun ? { duration: 0.8, repeat: Infinity } : { duration: 0.3 }}
                        className="flex h-4 flex-1 items-center justify-center rounded"
                      >
                        {isDone ? (
                          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                            <path d="M2 5l2 2 4-4" />
                          </svg>
                        ) : null}
                        {isRun ? (
                          <motion.span
                            animate={{ opacity: [0.4, 1, 0.4] }}
                            transition={{ duration: 1, repeat: Infinity }}
                            className="h-1 w-1 rounded-full bg-white"
                          />
                        ) : null}
                      </motion.div>
                    );
                  })}
                </div>
                <span className="w-[24px] text-right font-mono text-[10px] text-zinc-500">{done}/3</span>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-center gap-3 text-[10px]">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-zinc-300" />QUEUED
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-blue-500" />RUNNING
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-emerald-500" />SUCCEEDED
          </span>
          <span className="text-zinc-400">· 失败可整段重试</span>
        </div>
      </div>
    </div>
  );
};

// -----------------------------
// HISTORY tutorial visuals
// -----------------------------

const HistoryStep1: React.FC = () => {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setStep((s) => (s + 1) % 4), 1100);
    return () => window.clearInterval(id);
  }, []);
  type Row = { title: string; model: string; status: "SUCCEEDED" | "FAILED" | "RUNNING"; ratio: string; match: boolean[] };
  const rows: Row[] = [
    { title: "banana poster v1", model: "pro", status: "SUCCEEDED", ratio: "16:9", match: [true, true, true, true] },
    { title: "street shot", model: "flash", status: "FAILED", ratio: "1:1", match: [false, true, false, true] },
    { title: "banana poster v2", model: "pro", status: "SUCCEEDED", ratio: "16:9", match: [true, true, true, true] },
    { title: "night city", model: "pro", status: "SUCCEEDED", ratio: "4:3", match: [false, true, true, false] },
    { title: "banana farm", model: "flash", status: "RUNNING", ratio: "16:9", match: [true, false, true, true] },
  ];
  const cols = ["banana", "SUCCEEDED", "pro", "16:9"];
  const activeFilter = step;
  const labels = ["搜索", "状态", "model", "aspect"];
  return (
    <div className="absolute inset-0 flex items-stretch gap-4 p-6">
      <div className="w-[170px] space-y-2">
        {labels.map((l, i) => (
          <motion.div
            key={l}
            animate={{
              borderColor: i === activeFilter ? "#f5c518" : "#e4e4e7",
              background: i === activeFilter ? "#fffdf3" : "#ffffff",
            }}
            className="rounded-lg border px-3 py-2"
          >
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">{l}</div>
            <div className="mt-0.5 font-mono text-[12px] font-medium">
              {i === activeFilter ? <span className="text-[#7a5a00]">{cols[i]}</span> : "全部"}
            </div>
          </motion.div>
        ))}
      </div>
      <div className="flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <div className="flex justify-between border-b border-zinc-100 px-3 py-2 text-[11px] text-zinc-500">
          <span>任务列表</span>
          <span className="font-mono">
            {rows.filter((r) => r.match.slice(0, activeFilter + 1).every(Boolean)).length} / {rows.length}
          </span>
        </div>
        <div className="space-y-1 p-2">
          {rows.map((r, i) => {
            const visible = r.match.slice(0, activeFilter + 1).every(Boolean);
            const bg = r.status === "FAILED" ? "#fee2e2" : r.status === "RUNNING" ? "#dbeafe" : "#fef3c7";
            return (
              <motion.div
                key={i}
                animate={{
                  opacity: visible ? 1 : 0.25,
                  scale: visible ? 1 : 0.97,
                  background: visible ? "#fafafa" : "#ffffff",
                }}
                className="flex items-center gap-2 rounded-md border border-zinc-100 px-2.5 py-2"
              >
                <div className="h-7 w-7 rounded" style={{ background: bg }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-zinc-900">{r.title}</div>
                  <div className="font-mono text-[10px] text-zinc-500">
                    {r.model} · {r.ratio}
                  </div>
                </div>
                <Chip tone={r.status === "FAILED" ? "danger" : r.status === "RUNNING" ? "slate" : "success"}>{r.status}</Chip>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const HistoryStep2: React.FC = () => {
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSel((s) => (s + 1) % 3), 1400);
    return () => window.clearInterval(id);
  }, []);
  const thumbs = [
    "linear-gradient(135deg,#fde68a,#e0a800)",
    "linear-gradient(135deg,#a7f3d0,#059669)",
    "linear-gradient(135deg,#c7d2fe,#4338ca)",
  ];
  return (
    <div className="absolute inset-0 flex gap-4 p-6">
      <div className="w-[230px] space-y-1">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            animate={{
              background: i === sel ? "#0a0a0a" : "#ffffff",
              color: i === sel ? "#ffffff" : "#27272a",
              borderColor: i === sel ? "#0a0a0a" : "#e4e4e7",
            }}
            className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5"
          >
            <div className="h-8 w-8 rounded" style={{ background: thumbs[i] }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold">job_{["a3b9", "7f21", "d48e"][i]}…</div>
              <div className={`font-mono text-[10px] ${i === sel ? "text-zinc-400" : "text-zinc-500"}`}>
                {["2m ago", "12m ago", "1h ago"][i]}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
      <div className="flex-1 rounded-xl border border-zinc-200 bg-white p-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={sel}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold text-zinc-900">
                  job_{["a3b9c012", "7f21d0aa", "d48e1180"][sel]}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                  gemini-3-pro-image-preview · 16:9
                </div>
              </div>
              <Chip tone="success">SUCCEEDED</Chip>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-md border border-zinc-100"
                  style={{ aspectRatio: "4/3", background: thumbs[sel] }}
                />
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              {[
                ["Tokens", "1,248"],
                ["Cost", "$0.065"],
                ["Latency", "8.2s"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-md border border-zinc-100 bg-zinc-50 px-2 py-1.5">
                  <div className="text-[10px] uppercase text-zinc-500">{k}</div>
                  <div className="font-mono font-semibold">{v}</div>
                </div>
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

const HistoryStep3: React.FC = () => {
  const [action, setAction] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setAction((a) => (a + 1) % 4), 1200);
    return () => window.clearInterval(id);
  }, []);
  const actions = [
    { label: "置顶", icon: "📌", color: "#f5c518" },
    { label: "打标签", icon: "🏷️", color: "#a7f3d0" },
    { label: "重试", icon: "↻", color: "#bfdbfe" },
    { label: "删除", icon: "🗑", color: "#fecaca" },
  ];
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8">
      <div className="w-full max-w-[420px]">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,.04),0_1px_3px_rgba(0,0,0,.06)]">
          <div className="flex items-center gap-3">
            <div
              className="h-12 w-12 rounded-lg"
              style={{ background: "linear-gradient(135deg,#fde68a,#e0a800)" }}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-zinc-900">banana poster v1</div>
              <div className="font-mono text-[10px] text-zinc-500">job_a3b9c012… · 16:9</div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {actions.map((a, i) => (
              <motion.button
                key={a.label}
                animate={{
                  scale: i === action ? 1.08 : 1,
                  background: i === action ? a.color : "#f4f4f5",
                  color: "#111",
                }}
                className="flex flex-col items-center gap-1 rounded-lg border border-transparent py-2.5 text-[11px] font-medium"
              >
                <span className="text-[16px] leading-none">{a.icon}</span>
                <span>{a.label}</span>
              </motion.button>
            ))}
          </div>
          <div className="mt-3 text-center text-[11px] text-zinc-400">仅浏览器本地，不上传服务器</div>
        </div>
      </div>
    </div>
  );
};

// -----------------------------
// PICKER tutorial visuals
// -----------------------------

const PickerStep1: React.FC = () => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setCount((c) => (c + 1) % 9), 260);
    return () => window.clearInterval(id);
  }, []);
  const variants: ImgVariant[] = ["yellow", "amber", "peel", "sunset", "ocean", "mint", "rose", "yellow"];
  const colorMap: Record<string, string> = {
    yellow: "#fde68a",
    amber: "#fbbf24",
    peel: "#fff2b8",
    sunset: "#fca5a5",
    ocean: "#93c5fd",
    mint: "#a7f3d0",
    rose: "#fbcfe8",
  };
  return (
    <div className="nbp-tutorial-picker-grid absolute inset-0 flex items-center justify-center overflow-hidden px-5 py-4">
      <div className="w-full max-w-[420px]">
        <div className="mb-2 flex items-center justify-between">
          <Chip tone="banana">会话 · 海报挑选-演示</Chip>
          <span className="font-mono text-[11px] text-zinc-500">已导入 {count} / 8</span>
        </div>
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-200 bg-white p-1.5">
          <span className="shrink-0 pl-1 text-[9px] uppercase tracking-wider text-zinc-400">FROM HISTORY</span>
          <div className="flex flex-1 gap-1 overflow-hidden">
            {variants.map((v, i) => (
              <motion.div
                key={i}
                animate={{ opacity: i < count ? 0.35 : 1, scale: i === count - 1 ? 0.9 : 1 }}
                className="h-6 flex-1 overflow-hidden rounded border border-zinc-200"
                style={{ background: colorMap[v] || "#fde68a" }}
              />
            ))}
          </div>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#a1a1aa" strokeWidth="1.6" className="shrink-0">
            <path d="M4 8h8M9 4l4 4-4 4" />
          </svg>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {variants.map((v, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: i < count ? 1 : 0.1, y: i < count ? 0 : 20 }}
              transition={{ duration: 0.35 }}
              className="aspect-[4/3]"
            >
              <ImgTile variant={v} fill />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
};

const PickerStep2: React.FC = () => {
  const [mode, setMode] = useState<"ONE" | "TWO" | "FOUR" | "FILMSTRIP">("TWO");
  useEffect(() => {
    const seq: Array<"ONE" | "TWO" | "FOUR" | "FILMSTRIP"> = ["ONE", "TWO", "FOUR", "FILMSTRIP"];
    let i = 1;
    const id = window.setInterval(() => {
      i = (i + 1) % seq.length;
      setMode(seq[i]);
    }, 1500);
    return () => window.clearInterval(id);
  }, []);
  const modeLabel = { ONE: "1-up", TWO: "2-up", FOUR: "4-up", FILMSTRIP: "Filmstrip" } as const;
  const modes: Array<keyof typeof modeLabel> = ["ONE", "TWO", "FOUR", "FILMSTRIP"];
  return (
    <div className="nbp-tutorial-picker-grid absolute inset-0 flex flex-col overflow-hidden px-4 py-3">
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
        {modes.map((m) => (
          <motion.button
            key={m}
            animate={{
              background: mode === m ? "#111" : "#ffffff",
              color: mode === m ? "#fff" : "#52525b",
              scale: mode === m ? 1.04 : 1,
              borderColor: mode === m ? "#111" : "#e4e4e7",
            }}
            className="whitespace-nowrap rounded-md border px-2 py-1 text-[10px] font-semibold"
          >
            {modeLabel[m]}
          </motion.button>
        ))}
        <div className="flex-1" />
        <span className="whitespace-nowrap font-mono text-[10px] text-zinc-500">同步缩放 · 100%</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={mode}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            {mode === "ONE" ? (
              <div className="flex h-full items-center justify-center">
                <div className="aspect-[4/3] w-[55%]">
                  <ImgTile variant="yellow" label="A" fill />
                </div>
              </div>
            ) : null}
            {mode === "TWO" ? (
              <div className="grid h-full grid-cols-2 items-center gap-3">
                <div className="aspect-[4/3]">
                  <ImgTile variant="yellow" label="A" fill />
                </div>
                <div className="aspect-[4/3]">
                  <ImgTile variant="amber" label="B" fill />
                </div>
              </div>
            ) : null}
            {mode === "FOUR" ? (
              <div className="grid h-full grid-cols-2 grid-rows-2 gap-2">
                {(["yellow", "amber", "peel", "sunset"] as ImgVariant[]).map((v, i) => (
                  <div key={v} className="min-h-0">
                    <ImgTile variant={v} label={["A", "B", "C", "D"][i]} fill />
                  </div>
                ))}
              </div>
            ) : null}
            {mode === "FILMSTRIP" ? (
              <div className="flex h-full flex-col gap-2">
                <div className="min-h-0 flex-1">
                  <ImgTile variant="yellow" label="A" fill />
                </div>
                <div className="flex h-[58px] shrink-0 gap-2">
                  {(["amber", "peel", "sunset", "ocean", "mint"] as ImgVariant[]).map((v) => (
                    <div key={v} className="flex-1">
                      <ImgTile variant={v} fill />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

const PickerStep3: React.FC = () => {
  const [rA, setRA] = useState(0);
  const [rB, setRB] = useState(0);
  const [starred, setStarred] = useState(false);
  useEffect(() => {
    let a = 0;
    let b = 0;
    let tick = 0;
    const id = window.setInterval(() => {
      a = Math.min(a + 1, 5);
      b = Math.min(b + 1, 3);
      tick++;
      if (tick > 5) {
        a = 0;
        b = 0;
        tick = 0;
        setStarred(false);
      }
      if (tick === 5) setStarred(true);
      setRA(a);
      setRB(b);
    }, 600);
    return () => window.clearInterval(id);
  }, []);
  const cards: Array<{ label: string; r: number; v: ImgVariant; fav: boolean; id: string }> = [
    { label: "A", r: rA, v: "yellow", fav: starred, id: "b9" },
    { label: "B", r: rB, v: "amber", fav: false, id: "c1" },
  ];
  return (
    <div className="nbp-tutorial-picker-grid absolute inset-0 flex items-center justify-center p-6">
      <div className="grid w-full max-w-[480px] grid-cols-2 gap-3">
        {cards.map((card, i) => (
          <div key={i} className="space-y-2">
            <div className="relative aspect-[4/3]">
              <ImgTile variant={card.v} label={card.label} fill />
              {card.fav ? (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-[#f5c518]"
                  style={{ boxShadow: "0 0 0 3px rgba(245,197,24,.3)" }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="#000">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
                  </svg>
                </motion.div>
              ) : null}
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-2">
              <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-zinc-500">
                <span>job_a3{card.id}…</span>
                <span>{card.r}/5</span>
              </div>
              <Stars n={card.r} animate />
              {i === 0 && card.fav ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mt-1.5 border-t border-zinc-100 pt-1.5 text-[10px] italic text-zinc-600"
                >
                  “构图很干净，光线再暖一点”
                </motion.div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PickerStep4: React.FC = () => {
  const [best, setBest] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setBest((b) => (b + 1) % 4), 1100);
    return () => window.clearInterval(id);
  }, []);
  const variants: ImgVariant[] = ["yellow", "amber", "peel", "sunset"];
  const labels = ["A", "B", "C", "D"];
  return (
    <div className="nbp-tutorial-picker-grid absolute inset-0 flex items-center justify-center overflow-hidden px-6 py-5">
      <div className="w-full max-w-[380px]">
        <div className="grid grid-cols-2 grid-rows-2 gap-2">
          {variants.map((v, i) => (
            <div key={v} className="relative aspect-[4/3]">
              <ImgTile variant={v} label={labels[i]} selected={i === best} fill />
              {i === best ? (
                <motion.div
                  initial={{ scale: 0, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full"
                  style={{ background: "#f5c518", boxShadow: "0 0 0 3px rgba(245,197,24,.3)" }}
                >
                  <span className="text-[9px] font-black leading-none tracking-wider text-black">BEST</span>
                </motion.div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const PickerStep5: React.FC = () => {
  const [prog, setProg] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setProg((p) => (p >= 100 ? 0 : p + 4)), 80);
    return () => window.clearInterval(id);
  }, []);
  const variants: ImgVariant[] = ["yellow", "amber", "peel", "sunset"];
  const labels = ["A", "B", "C", "D"];
  return (
    <div className="nbp-tutorial-picker-grid absolute inset-0 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-[400px]">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,.04),0_1px_3px_rgba(0,0,0,.06)]">
          <div className="flex items-center gap-3">
            <motion.div
              animate={{ y: [0, -4, 0] }}
              transition={{ repeat: Infinity, duration: 1.2 }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#f5c518]"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 3v13m0 0l-5-5m5 5l5-5M5 21h14" />
              </svg>
            </motion.div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-zinc-900">下载精选图</div>
              <div className="font-mono text-[11px] text-zinc-500">4 selected · zip</div>
            </div>
            <span className="font-mono text-[12px] font-semibold text-zinc-900">{prog}%</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <motion.div
              animate={{ width: `${prog}%` }}
              className="h-full"
              style={{ background: "linear-gradient(90deg,#f5c518,#f97316)" }}
            />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {variants.map((v, i) => (
              <div key={v} className="relative aspect-[4/3]">
                <ImgTile variant={v} label={labels[i]} fill />
                {prog > (i + 1) * 25 ? (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500"
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                      <path d="M2 5l2 2 4-4" />
                    </svg>
                  </motion.div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// -----------------------------
// Step definitions
// -----------------------------

const ICONS = {
  prompt: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 4h16v12H5.5L4 17.5z" />
    </svg>
  ),
  image: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 17l-6-6-8 8" />
    </svg>
  ),
  knob: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
    </svg>
  ),
  play: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 4l14 8-14 8z" />
    </svg>
  ),
  grid: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  filter: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 5h18l-7 8v6l-4-2v-4z" />
    </svg>
  ),
  star: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
    </svg>
  ),
  trophy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 4h10v4a5 5 0 01-10 0V4zM3 5h4v3a3 3 0 01-3-3zm18 0h-4v3a3 3 0 003-3zM10 14h4v4h-4zm-3 4h10v2H7z" />
    </svg>
  ),
  down: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v13m0 0l-5-5m5 5l5-5M5 21h14" />
    </svg>
  ),
  list: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
  layers: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3L3 8l9 5 9-5zM3 14l9 5 9-5" />
    </svg>
  ),
  tag: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 12l9-9h8v8l-9 9z" />
      <circle cx="15" cy="9" r="1.5" />
    </svg>
  ),
  brand: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7l9-4 9 4-9 4zm0 5l9 4 9-4m-18 5l9 4 9-4" />
    </svg>
  ),
} as const;

type TutorialStep = {
  label: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  Visual: React.ComponentType;
};

const CREATE_STEPS: TutorialStep[] = [
  {
    label: "写 Prompt",
    icon: ICONS.prompt,
    title: "描述你想要的画面",
    desc: "尽量包含主体 · 风格 · 光照 · 构图 · 镜头。也可以只写几个关键词，让模型自由发挥。",
    Visual: CreateStep1,
  },
  {
    label: "参考图 (可选)",
    icon: ICONS.image,
    title: "拖拽上传最多 14 张参考图",
    desc: "支持文本 + 多图模式。参考图会影响构图、色彩或风格的延续性。",
    Visual: CreateStep2,
  },
  {
    label: "调参数",
    icon: ICONS.knob,
    title: "模型 · 比例 · 尺寸 · 温度",
    desc: "默认值来自 Settings。每个模型的可选参数不同，界面会自动适配。一次可生成多张（job_count）。",
    Visual: CreateStep3,
  },
  {
    label: "生成 & 查看",
    icon: ICONS.play,
    title: "提交后自动排队并轮询",
    desc: "QUEUED → RUNNING → SUCCEEDED。失败可直接重试，结果保存在 History 中。",
    Visual: CreateStep4,
  },
];

const BATCH_STEPS: TutorialStep[] = [
  {
    label: "场景",
    icon: ICONS.layers,
    title: "一次搞定一整套 PPT 主视觉",
    desc: "以「产品发布会 · 5 页 PPT · 每页 3 张候选图」为例：手动需要打开 Create 15 次，Batch 只需提交 1 次。",
    Visual: BatchStep1,
  },
  {
    label: "全局设置",
    icon: ICONS.brand,
    title: "先定义批次的全局配置",
    desc: "批次名 · 全局 Prompt · 全局模型 · 输出比例…作为默认值自动下发给每个分段，每段可再独立覆盖。",
    Visual: BatchStep2,
  },
  {
    label: "分段 = 每页",
    icon: ICONS.play,
    title: "每一页 PPT 对应一个 Section",
    desc: "在同一个分段里填写该页独有的 Prompt 与参数，job_count 决定出几张候选。切换分段可实时预览不同页面的生成方向。",
    Visual: BatchStep3,
  },
  {
    label: "命名模板",
    icon: ICONS.tag,
    title: "会话名自动渲染 · 不再手动命名",
    desc: "{{batch}} / {{page_no}} / {{section}} 三个占位符按分段自动渲染，每页子任务自动归档到对应会话。",
    Visual: BatchStep4,
  },
  {
    label: "并行执行",
    icon: ICONS.brand,
    title: "一键提交 · 多段并行 · 实时监控",
    desc: "所有分段并行入队，子任务状态在批次视图与 History 中同步。任何一段失败都可整段或单任务重试。",
    Visual: BatchStep5,
  },
];

const HISTORY_STEPS: TutorialStep[] = [
  {
    label: "叠加筛选",
    icon: ICONS.filter,
    title: "多维筛选 · 组合定位",
    desc: "按关键词 · 状态 · 模型 · 比例 · 日期叠加筛选。结果只读自浏览器本地，不上传。",
    Visual: HistoryStep1,
  },
  {
    label: "查看详情",
    icon: ICONS.list,
    title: "点击任意任务查看完整信息",
    desc: "详情包含结果图、Token 用量、费用估算、耗时、参数 · 请求 · 响应回看。",
    Visual: HistoryStep2,
  },
  {
    label: "快捷操作",
    icon: ICONS.knob,
    title: "置顶 · 打标签 · 重试 · 删除",
    desc: "历史项目可置顶常用任务，打标签便于搜索；失败任务可直接基于同一参数重试。",
    Visual: HistoryStep3,
  },
];

const PICKER_STEPS: TutorialStep[] = [
  {
    label: "导入图像",
    icon: ICONS.layers,
    title: "从 History 一键导入",
    desc: "把多个任务的结果图汇入一个「挑选会话」。会话完全在本地持久化。",
    Visual: PickerStep1,
  },
  {
    label: "切换布局",
    icon: ICONS.grid,
    title: "1-up · 2-up · 4-up · Filmstrip",
    desc: "按对比密度切换布局。同步缩放可在多图间保持视角一致，便于细节对比。",
    Visual: PickerStep2,
  },
  {
    label: "评分标记",
    icon: ICONS.star,
    title: "0 ~ 5 星 · 精选 · 备注",
    desc: "每张图可评分、标记精选或写备注。系统会基于评分与行为调度下一轮展示。",
    Visual: PickerStep3,
  },
  {
    label: "选出最佳",
    icon: ICONS.trophy,
    title: "设为 BEST · 作为会话封面",
    desc: "一张最好的图会被保留为会话封面，后续可以直接回到这张图或做进一步迭代。",
    Visual: PickerStep4,
  },
  {
    label: "下载精选",
    icon: ICONS.down,
    title: "一键下载全部精选图",
    desc: "勾选的图片会打包下载为 zip。也可以继续沉浸式全屏审阅，切换深色/网格背景。",
    Visual: PickerStep5,
  },
];

const PAGE_CONFIG: Record<TutorialPage, { title: string; subtitle: string; tag: string; steps: TutorialStep[] }> = {
  Create: { title: "欢迎使用 Create", subtitle: "单任务快速生成一张图", tag: "Create", steps: CREATE_STEPS },
  Batch: { title: "欢迎使用 Batch", subtitle: "分段批量出图 · 自动归档", tag: "Batch", steps: BATCH_STEPS },
  History: { title: "欢迎使用 History", subtitle: "本地历史 · 叠加筛选", tag: "History", steps: HISTORY_STEPS },
  Picker: { title: "欢迎使用 Picker", subtitle: "挑图工作流 · 多图对比", tag: "Picker", steps: PICKER_STEPS },
};

// -----------------------------
// Shell
// -----------------------------

function TutorialShell({
  title,
  subtitle,
  pageTag,
  steps,
  onClose,
}: {
  title: string;
  subtitle: string;
  pageTag: string;
  steps: TutorialStep[];
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const step = steps[i];
  const total = steps.length;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      } else if (ev.key === "ArrowRight") {
        setI((v) => Math.min(total - 1, v + 1));
      } else if (ev.key === "ArrowLeft") {
        setI((v) => Math.max(0, v - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, total]);

  const next = () => {
    if (i < total - 1) setI(i + 1);
    else onClose();
  };
  const prev = () => setI(Math.max(0, i - 1));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6">
      <div
        className="absolute inset-0"
        data-testid="tutorial-backdrop"
        style={{ background: "rgba(10,10,10,0.55)", backdropFilter: "blur(6px)" }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 教程`}
        className="relative w-[860px] max-w-[94vw] overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.04),0_1px_3px_rgba(0,0,0,.06)]"
      >
        <div className="flex items-center justify-between px-6 pb-3 pt-5">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-500">
              新手教程 · {pageTag}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭教程"
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-zinc-100"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="px-6 pb-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-[22px] font-semibold tracking-tight text-zinc-900">{title}</h1>
            <span className="text-sm text-zinc-500">{subtitle}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[260px_1fr]" style={{ minHeight: 340 }}>
          <div className="border-b border-zinc-100 px-6 py-4 sm:border-b-0 sm:border-r">
            <div className="mb-3 text-[11px] uppercase tracking-wider text-zinc-400">Steps</div>
            <div className="space-y-1">
              {steps.map((s, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setI(idx)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-all ${
                    idx === i ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-50"
                  }`}
                >
                  <span
                    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                      idx === i ? "bg-[#f5c518] text-black" : "bg-zinc-100 text-zinc-500"
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="relative overflow-hidden">
            <div key={`step-${i}`} className="absolute inset-0 flex flex-col">
              <div className="relative flex-1 bg-[#fafafa]">
                <step.Visual />
              </div>
              <div className="border-t border-zinc-100 bg-white px-6 py-4">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-zinc-900">
                  {step.icon}
                  <span>{step.title}</span>
                </div>
                <div className="mt-1 text-[13px] leading-relaxed text-zinc-600">{step.desc}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-100 px-6 py-4">
          <div className="mr-3 flex items-center gap-1">
            {steps.map((_, idx) => (
              <Dot key={idx} active={idx === i} />
            ))}
          </div>
          <button
            type="button"
            onClick={prev}
            disabled={i === 0}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium ${
              i === 0 ? "text-zinc-300" : "text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            上一步
          </button>
          <button
            type="button"
            onClick={next}
            className="rounded-lg bg-zinc-900 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-black"
          >
            {i === total - 1 ? "开始使用 →" : "下一步"}
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------
// Public trigger component
// -----------------------------

export function TutorialTrigger({
  page,
  className,
  label = "教程",
}: {
  page: TutorialPage;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const config = useMemo(() => PAGE_CONFIG[page], [page]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = readSeen();
    if (!seen[page]) {
      setOpen(true);
      markSeen(page);
    }
  }, [page]);

  const handleClose = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${config.tag} 教程`}
        title={`查看 ${config.tag} 教程`}
        className={
          className ??
          "inline-flex items-center gap-1.5 rounded-xl border border-[#f5c518] bg-[#fffef7] px-3 py-2 text-sm font-semibold text-[#7a5a00] transition hover:bg-[#fff6cf]"
        }
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l3 6 6 .8-4.5 4.2 1 6L12 16l-5.5 3 1-6L3 8.8 9 8z" />
        </svg>
        {label}
      </button>
      {open ? (
        <TutorialShell
          title={config.title}
          subtitle={config.subtitle}
          pageTag={config.tag}
          steps={config.steps}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}
