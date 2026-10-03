/**
 * Site footer.
 *
 * Adapted from a 21st.dev footer template. Changes from the original:
 *  - every link points at a real destination in this project (the template's
 *    /faqs, /pricing, /privacy etc. do not exist here)
 *  - shadcn design tokens swapped for this project's greyscale tokens
 *  - Tailwind v4 syntax (rounded-t-6xl, theme()) downgraded to v3
 *  - social links reduced to the one account that actually exists
 */
import React from "react";
import type { ComponentProps, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Shield, Github, ExternalLink, FileText, CircleDot, Cpu } from "lucide-react";

const REPO = "https://github.com/0xsan7/AI-SOC-Analyst-Honeypot";
const DOCS = `${REPO}/blob/main/README.md`;

interface FooterLink {
  title: string;
  href: string;
  icon?: React.ComponentType<{ className?: string }>;
  external?: boolean;
}

interface FooterSection {
  label: string;
  links: FooterLink[];
}

const footerLinks: FooterSection[] = [
  {
    label: "Product",
    links: [
      { title: "How it works", href: "./#how-it-works" },
      { title: "Live dashboard", href: "./dashboard.html" },
      { title: "Setup", href: "./#setup" },
    ],
  },
  {
    label: "Documentation",
    links: [
      { title: "Quick start", href: `${DOCS}#quick-start`, external: true },
      { title: "Commands", href: `${DOCS}#commands`, external: true },
      { title: "MCP server", href: `${DOCS}#mcp-server`, external: true },
      { title: "Security model", href: `${DOCS}#security-model`, external: true },
    ],
  },
  {
    label: "Project",
    links: [
      { title: "Source code", href: REPO, icon: Github, external: true },
      { title: "Report an issue", href: `${REPO}/issues`, icon: CircleDot, external: true },
      { title: "Product spec", href: `${REPO}/blob/main/PRD.md`, icon: FileText, external: true },
      { title: "Example report", href: `${REPO}/blob/main/examples/example-report.md`, icon: Cpu, external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative mx-auto w-full max-w-6xl rounded-t-[2rem] border-t border-line bg-ink px-6 py-12 lg:rounded-t-[2.5rem] lg:py-16">
      <div
        className="pointer-events-none absolute left-1/2 top-0 h-px w-1/3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-body/20 blur"
        aria-hidden="true"
      />

      <div className="grid w-full gap-8 xl:grid-cols-3 xl:gap-8">
        <AnimatedContainer className="space-y-4">
          <Shield className="size-8 text-body" aria-hidden />
          <p className="mt-8 text-sm text-faint md:mt-0">
            &copy; {new Date().getFullYear()} 0xsan7. All rights reserved.
          </p>
          <p className="max-w-xs text-sm leading-relaxed text-faint">
            Defensive research tool. Attacker commands are recorded and simulated,
            never executed.
          </p>
        </AnimatedContainer>

        <div className="mt-10 grid grid-cols-2 gap-8 md:grid-cols-3 xl:col-span-2 xl:mt-0">
          {footerLinks.map((section, index) => (
            <AnimatedContainer key={section.label} delay={0.1 + index * 0.1}>
              <div className="mb-10 md:mb-0">
                <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-faint">
                  {section.label}
                </h3>
                <ul className="mt-4 space-y-2 text-sm">
                  {section.links.map((link) => (
                    <li key={link.title}>
                      <a
                        href={link.href}
                        className="group inline-flex items-center gap-1.5 text-muted transition-colors duration-300 hover:text-body"
                        {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                      >
                        {link.icon && <link.icon className="size-4" aria-hidden />}
                        {link.title}
                        {link.external && (
                          <ExternalLink
                            className="size-3 opacity-0 transition-opacity group-hover:opacity-60"
                            aria-hidden
                          />
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </AnimatedContainer>
          ))}
        </div>
      </div>
    </footer>
  );
}

type ViewAnimationProps = {
  delay?: number;
  className?: ComponentProps<typeof motion.div>["className"];
  children: ReactNode;
};

function AnimatedContainer({ className, delay = 0.1, children }: ViewAnimationProps) {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      initial={{ filter: "blur(4px)", translateY: -8, opacity: 0 }}
      whileInView={{ filter: "blur(0px)", translateY: 0, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ delay, duration: 0.8 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export default Footer;
