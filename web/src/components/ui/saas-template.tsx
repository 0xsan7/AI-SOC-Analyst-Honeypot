/**
 * Landing page for SOC Analyst.
 *
 * Adapted from a 21st.dev SaaS hero template. Changes from the original:
 *  - copy rewritten for this project (no "Landing page kit" placeholder text)
 *  - lucide-react for icons instead of hand-rolled SVGs
 *  - placeholder CDN images replaced with the real dashboard screenshot
 *  - links point at the real dashboard and repo
 */
import React from "react";
import { ArrowRight, Menu, X, Shield, Github } from "lucide-react";
import { Footer } from "./footer-section";

type ButtonVariant = "default" | "secondary" | "ghost" | "gradient";
type ButtonSize = "default" | "sm" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: React.ReactNode;
  /** When set the button renders an <a> so it behaves like a real link. */
  href?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "default", className = "", children, href, ...props }, ref) => {
    const baseStyles =
      "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-body/40 disabled:pointer-events-none disabled:opacity-50";

    const variants: Record<ButtonVariant, string> = {
      default: "bg-white text-black hover:bg-gray-100",
      secondary: "border border-line-lit bg-raised text-body hover:bg-[#1f1f1f]",
      ghost: "text-muted hover:bg-raised hover:text-body",
      gradient: "bg-body text-ink hover:bg-white active:scale-[0.98]",
    };

    const sizes: Record<ButtonSize, string> = {
      default: "h-10 px-4 py-2 text-sm",
      sm: "h-10 px-5 text-sm",
      lg: "h-12 px-8 text-base",
    };

    // When `href` is set, render an anchor: navigation gets middle-click,
    // ctrl/cmd-click, "open in new tab", and keyboard access for free.
    if (href) {
      const external = /^https?:/i.test(href);
      return (
        <a
          href={href}
          className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
          {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          {children}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

const NAV_LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Dashboard", href: "./dashboard.html" },
  { label: "Setup", href: "#setup" },
];

const Navigation = React.memo(() => {
  const [open, setOpen] = React.useState(false);

  return (
    <header className="fixed top-0 z-50 w-full border-b border-line bg-ink/80 backdrop-blur-md">
      <nav className="mx-auto max-w-7xl px-6 py-4">
        <div className="flex items-center justify-between">
          <a href="./" className="flex items-center gap-2 text-lg font-semibold text-white">
            <Shield className="h-5 w-5 text-body" aria-hidden />
            SOC Analyst
          </a>

          <div className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-8 md:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="text-sm text-muted transition-colors hover:text-body"
              >
                {l.label}
              </a>
            ))}
          </div>

          <div className="hidden items-center gap-4 md:flex">
            <Button variant="ghost" size="sm" href="https://github.com/0xsan7/Honeypot">
              <Github className="h-4 w-4" />
              Source
            </Button>
            <Button size="sm" href="./dashboard.html">
              Live dashboard
            </Button>
          </div>

          <button
            type="button"
            className="text-white md:hidden"
            onClick={() => setOpen(!open)}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="animate-[slideDown_0.3s_ease-out] border-t border-line bg-ink/95 backdrop-blur-md md:hidden">
          <div className="flex flex-col gap-4 px-6 py-4">
            {NAV_LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="py-2 text-sm text-muted transition-colors hover:text-body"
                onClick={() => setOpen(false)}
              >
                {l.label}
              </a>
            ))}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <Button variant="ghost" size="sm" href="./dashboard.html">
                Live dashboard
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
});
Navigation.displayName = "Navigation";

const STAGES = [
  { n: "01", t: "Honeypot", d: "An SSH server that accepts any credential and answers from a static table. It records what was tried and never runs it." },
  { n: "02", t: "Triage", d: "Gemini grades every event: noise, recon, credential stuffing, or active exploitation, with a severity from 1 to 5." },
  { n: "03", t: "Enrich", d: "Geo, ASN, and reputation lookups, each degrading to a warning when a key is missing so the pipeline never dies." },
  { n: "04", t: "Correlate", d: "Events from one source inside a 30-minute window collapse into a single campaign, persisted in LibSQL across restarts." },
  { n: "05", t: "Report", d: "Crossing severity 4 or five events writes a markdown incident report with IOCs and a plain-language summary." },
];

const Hero = React.memo(() => {
  return (
    <section
      className="relative flex min-h-screen flex-col items-center justify-start px-6 py-20 md:py-24"
      style={{ animation: "fadeIn 0.6s ease-out" }}
    >
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes floatUp {
          from { opacity: 0; transform: translateY(24px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>

      <aside className="mb-8 inline-flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-line bg-panel px-4 py-2 backdrop-blur-sm">
        <span className="whitespace-nowrap text-center text-xs text-muted">
          Runs entirely on your own hardware
        </span>
        <a
          href="#setup"
          className="flex items-center gap-1 whitespace-nowrap text-xs text-muted transition-all hover:text-body active:scale-95"
        >
          See setup
          <ArrowRight size={12} />
        </a>
      </aside>

      <h1
        className="mb-6 max-w-3xl px-6 text-center text-4xl font-medium leading-tight md:text-5xl lg:text-6xl"
        style={{
          background: "linear-gradient(to bottom, #ffffff, #ffffff, rgba(255,255,255,0.6))",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
          letterSpacing: "-0.04em",
        }}
      >
        Every attacker <br />
        becomes a report
      </h1>

      <p className="mb-10 max-w-2xl px-6 text-center text-sm text-muted md:text-base">
        A self-hosted SSH honeypot that hands every login attempt to an LLM, grades it,
        groups repeat offenders into campaigns, and writes the incident report for you.
      </p>

      <div className="relative z-10 mb-16 flex items-center gap-4">
        <Button variant="gradient" size="lg" className="rounded-lg" href="./dashboard.html">
          View live dashboard
        </Button>
        <Button
          variant="secondary"
          size="lg"
          className="rounded-lg"
          href="https://github.com/0xsan7/Honeypot"
        >
          Source
        </Button>
      </div>

      <div className="relative w-full max-w-5xl pb-20">
        {/* Glow behind the screenshot — replace with a real asset if you have one. */}
        <div
          className="pointer-events-none absolute left-1/2 top-[-23%] z-0 w-[90%] -translate-x-1/2"
          aria-hidden="true"
          style={{
            height: 320,
            background:
              "radial-gradient(ellipse at center, rgba(255,255,255,0.16), transparent 70%)",
            filter: "blur(40px)",
          }}
        />
        <div className="relative z-10" style={{ animation: "floatUp 0.9s cubic-bezier(0.22,1,0.36,1) 0.25s both" }}>
          <img
            src="./dashboard.png"
            alt="SOC Analyst dashboard showing attack volume by severity, top source IPs, open campaigns, and a live event stream"
            className="w-full rounded-lg border border-line-lit shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]"
            loading="eager"
          />
        </div>
      </div>
    </section>
  );
});
Hero.displayName = "Hero";

const Pipeline = React.memo(() => {
  return (
    <section id="how-it-works" className="mx-auto max-w-7xl px-6 py-24">
      <h2 className="mb-3 text-3xl font-medium tracking-tight md:text-4xl">
        Five stages, one command
      </h2>
      <p className="mb-14 max-w-2xl text-muted">
        Each stage is a separate, testable step. The only one that calls an LLM is
        triage — correlation and reporting are deterministic, so they keep working
        when a quota runs out.
      </p>
      <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2 lg:grid-cols-5">
        {STAGES.map((s) => (
          <li key={s.n} className="bg-panel p-6 transition-colors hover:bg-raised">
            <span className="font-mono text-xs text-faint">{s.n}</span>
            <h3 className="mb-2 mt-3 text-lg font-medium">{s.t}</h3>
            <p className="text-sm leading-relaxed text-muted">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
});
Pipeline.displayName = "Pipeline";

const Setup = React.memo(() => {
  return (
    <section id="setup" className="border-t border-line bg-surface">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <h2 className="mb-3 text-3xl font-medium tracking-tight md:text-4xl">
          Clone and run
        </h2>
        <p className="mb-10 max-w-2xl text-muted">
          No API key needed for the demo path. Seed synthetic events, correlate them,
          and open the dashboard.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-line bg-ink p-6 font-mono text-sm leading-relaxed text-muted">
          <code>{`git clone https://github.com/0xsan7/Honeypot.git
cd Honeypot
npm install

# demo path — no LLM calls
npm run seed
npm run correlate
npm run dashboard     # http://127.0.0.1:4173

# live path — attacks a real honeypot, needs a Gemini key
npm run keys
npm run honeypot       # terminal 1
npm run probe          # terminal 2
npm run pipeline`}</code>
        </pre>
      </div>
    </section>
  );
});
Setup.displayName = "Setup";

export default function Component() {
  return (
    <div className="min-h-screen bg-ink text-body">
      <Navigation />
      <Hero />
      <Pipeline />
      <Setup />
      <Footer />
    </div>
  );
}
