# LUWI native adapter evidence

The Phase 3 adapters are intentionally narrow. Detection invokes only a resolved executable
with `--version`; passive inspection never executes configuration, hooks, plugins, skills,
or MCP commands. All paths and command collaborators are injected.

Native version probes run without a shell, have a 2.5 second wall-clock timeout, and enforce
separate 64 KiB stdout and stderr limits. A missing, hanging, or noisy executable is reported
as unavailable without exposing partial output, and does not prevent sibling adapters from
being detected.

For Phase 4, every adapter also declares token-usage extraction, context-loading evidence,
and native session-summary support. All four current adapters explicitly report those
telemetry capabilities as `unsupported` with no supported usage fields. LUWI therefore does
not infer provider token counts or loaded/invoked facts from these adapters. Trusted local
Session Bridges may submit separately validated reported observations through the daemon.

The implemented paths and formats were checked on 2026-07-29 against these vendor sources:

- Codex: [configuration reference](https://developers.openai.com/codex/config-reference/)
  and [AGENTS.md guidance](https://developers.openai.com/codex/guides/agents-md/). LUWI
  observes `~/.codex/config.toml`, project `.codex/config.toml`, global
  `~/.codex/AGENTS.md`, and project `AGENTS.md`. The writable subset is limited to
  `model`, `approval_policy`, `sandbox_mode`, and `sandbox_workspace_write`.
- Claude Code: [settings and scope reference](https://code.claude.com/docs/en/settings) and
  [.claude directory reference](https://code.claude.com/docs/en/claude-directory). LUWI
  observes user/project `settings.json`, project `settings.local.json`, and the documented
  `CLAUDE.md` locations. The writable subset is limited to `model` and `permissions`.
- Gemini CLI: [configuration reference](https://geminicli.com/docs/reference/configuration/)
  and [GEMINI.md reference](https://geminicli.com/docs/cli/gemini-md/). LUWI observes
  user/project `.gemini/settings.json` and `GEMINI.md`; native writes remain read-only.
- Kimi Code CLI: [data locations](https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html)
  and [agent/context configuration](https://moonshotai.github.io/kimi-cli/en/customization/agents.html).
  LUWI observes `~/.kimi/config.toml` plus project `AGENTS.md` and `.kimi/AGENTS.md`.
  No project-local Kimi config file or native write behavior is assumed.

Unknown effective settings are omitted from writable render output and listed explicitly in
the ConfigPlan warnings. This is not a complete native schema implementation. Extending a
writable subset requires a vendor reference, fixture coverage, management-mode tests, and a
separately reviewed adapter change.
