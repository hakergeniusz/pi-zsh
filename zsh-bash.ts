/**
 * zsh-bash — make pi's `bash` tool actually run zsh, with the user's .zshrc.
 *
 * Pi hardcodes /bin/bash for the bash tool (dist/utils/shell.js). Bash never
 * reads .zshrc, so everything that lives there — the consolidated PATH, `alias
 * ls=eza`, `grep=rg`, `cat=bat`, `sudo=sudo-rs`, the `claude`/`claude-env`
 * functions, PNPM_HOME, LD_LIBRARY_PATH — was invisible to the agent while it
 * was plainly available to the human in the same terminal. This extension
 * closes that gap: every bash tool call is routed through a small zsh wrapper
 * that sources the real .zshrc first.
 *
 * How the routing works
 * ---------------------
 * Pi builds its bash tool once, at session creation, from settings that an
 * extension cannot reach (`ctx` has no SettingsManager), so the shell cannot be
 * swapped from inside the tool. Two supported hooks can still get there:
 *
 *  - `tool_call` for the model-facing tool: the command is rewritten to
 *    `<wrapper> '<command>'`. The wrapper re-parses it with `eval`, so zsh
 *    syntax, pipes, heredocs and multiline scripts survive intact, and the
 *    single-quote wrapping is byte-safe for any input without NUL.
 *  - `user_bash` for the human's own `!command`: pi accepts replacement
 *    `operations`, so the command is handed to pi's standard local execution
 *    backend with `shellPath` pointing at the same wrapper. No quoting at all.
 *
 * Modes
 * -----
 *  - `rc` (default): a non-interactive zsh that `source`s .zshrc. Interactive
 *    guards such as `[[ -o interactive ]] && return` skip the parts of the rc
 *    that only make sense on a TTY — which is exactly what you want for a
 *    command run, and it keeps stray prompt/banner output out of the result.
 *  - `interactive`: `zsh -i` against a private ZDOTDIR whose .zshrc sources
 *    yours, for rc files that bail out early unless the shell is interactive.
 *    History expansion (`!`) and history writes are disabled there, because
 *    `echo done!` must not turn into "event not found".
 *
 * Either way the rc's stdout is discarded — otherwise a greeting/banner in the
 * rc would be prepended to the output of every single command — and its stderr
 * goes to `<cache>/pi/zsh-bash/rc.log`, readable with `/zsh-bash log`.
 *
 * Note: sourcing .zshrc also sources whatever it sources. This user's rc pulls
 * in ~/.zsh_secrets, so shell commands run by the agent inherit those
 * variables. Use `/zsh-bash off` (or PI_ZSH_BASH=0) if that is not wanted.
 *
 * Env: PI_ZSH_BASH=0 disables, PI_ZSH_BASH_MODE=interactive picks the mode.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createLocalBashOperations,
	type BashOperations,
	type ExtensionAPI,
	type ToolCallEvent,
	type UserBashEvent,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

type Mode = "rc" | "interactive";

const COMMAND = "zsh-bash";
const USAGE = "Usage: /zsh-bash [status | on | off | rc | interactive | log | aliases]";

/** Session-scoped state. Recomputed on every factory run. */
let enabled = true;
let mode: Mode = "rc";
let zshBin: string | null = null;
let rcFile = "";
let wrapperPath = "";
let rcLogPath = "";
let zdotDir = "";
let disabledReason: string | undefined;
/** Cached `operations` for user_bash; pi spawns a fresh child per command. */
let userOperations: BashOperations | null = null;
/** Cached alias list harvested from the live rc, for the system prompt bullet. */
let aliasNames: string[] | null = null;

export default function zshBash(pi: ExtensionAPI) {
	init();

	pi.on("session_start", () => {
		// The wrapper depends on $HOME and the resolved zsh, both of which can
		// change with a session swap, so rebuild rather than trust the factory.
		// Deliberately silent: no footer status, no startup notification. State
		// is one `/zsh-bash status` away, and a quiet footer is worth more.
		init();
	});

	/* Model-facing bash tool: rewrite the command to go through the wrapper. */
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash") return;
		if (!active()) return;
		const input = event.input as { command?: string };
		const command = input.command;
		if (typeof command !== "string" || command.trim() === "") return;
		// Idempotent: another handler (or a resumed call) must not double-wrap.
		if (command.startsWith(`${wrapperPath} `)) return;
		input.command = `${wrapperPath} ${quote(command)}`;
	});

	/* Human `!command`: hand pi real operations instead of rewriting text. */
	pi.on("user_bash", (_event: UserBashEvent): UserBashEventResult | undefined => {
		if (!active()) return undefined;
		if (!userOperations) {
			// pi calls this as `<wrapper> -c <command>`; the wrapper handles both
			// that and the bare `<wrapper> <command>` form used above.
			userOperations = createLocalBashOperations({ shellPath: wrapperPath });
		}
		return { operations: userOperations };
	});

	/* One stable prompt bullet, so the model writes zsh and expects the rc. */
	pi.on("before_agent_start", async (event) => {
		if (!active()) return;
		const guideline = await promptGuideline();
		if (!guideline) return;
		const guidelines = event.systemPromptOptions.promptGuidelines;
		if (!guidelines.includes(guideline)) guidelines.push(guideline);
	});

	pi.registerCommand(COMMAND, {
		description: "Route pi's bash tool through zsh with your .zshrc loaded",
		getArgumentCompletions: (prefix) =>
			["status", "on", "off", "rc", "interactive", "log", "aliases"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "on" || action === "off" || action === "rc" || action === "interactive") {
				const failure = zshRequiredFailure(action);
				if (failure) {
					ctx.ui.notify(`zsh-bash: ${failure}`, "error");
					return;
				}
				enabled = action !== "off";
				if (action === "rc" || action === "interactive") {
					mode = action;
					init();
				}
				ctx.ui.notify(describe(), "info");
				return;
			}

			if (action === "log") {
				ctx.ui.notify(readLog(), "info");
				return;
			}

			if (action === "aliases") {
				const names = await collectAliases(true);
				ctx.ui.notify(
					names.length ? `aliases from ${rcFile}: ${names.join(", ")}` : "no aliases found in the rc",
					"info",
				);
				return;
			}

			if (action === "" || action === "status") {
				ctx.ui.notify(describe(), active() ? "info" : "warning");
				return;
			}

			ctx.ui.notify(USAGE, "warning");
		},
	});
}

/* ------------------------------------------------------------------ *
 * Wiring helpers
 * ------------------------------------------------------------------ */

function active(): boolean {
	return enabled && !disabledReason && zshBin !== null;
}

function describe(): string {
	if (disabledReason) return `zsh-bash: off — ${disabledReason}`;
	if (!enabled) return "zsh-bash: off — bash runs as pi's default (/bin/bash). /zsh-bash on to re-enable.";
	const flavour = mode === "interactive" ? "zsh -i (private ZDOTDIR)" : "zsh + sourced rc";
	return (
		`zsh-bash: on — ${flavour}\n` +
		`  zsh:     ${zshBin}\n` +
		`  rc:      ${rcFile}${fs.existsSync(rcFile) ? "" : " (missing — nothing to source)"}\n` +
		`  wrapper: ${wrapperPath}\n` +
		`  rc log:  ${rcLogPath}`
	);
}

function zshRequiredFailure(action: string): string | undefined {
	if (disabledReason) return disabledReason;
	if (!zshBin && action !== "off") return "zsh was not found on PATH";
	return undefined;
}

async function promptGuideline(): Promise<string | undefined> {
	const names = await collectAliases(false);
	const aliasHint = names.length
		? ` rc aliases are live: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}.`
		: "";
	return `The bash tool runs zsh, not bash, and has this machine's .zshrc loaded.${aliasHint} Write zsh syntax; do not assume POSIX sh.`;
}

/**
 * Alias names from the live rc, harvested through the wrapper so the list
 * reflects what the wrapper really loads. Cached; `force` refreshes for
 * `/zsh-bash aliases`.
 */
async function collectAliases(force: boolean): Promise<string[]> {
	if (aliasNames && !force) return aliasNames;
	if (!active()) return [];
	try {
		const result = spawnSync(wrapperPath, ["alias"], {
			timeout: 10_000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			env: process.env,
		});
		if (result.status !== 0 || !result.stdout) return (aliasNames = []);
		const names = result.stdout
			.split("\n")
			.map((line) => line.match(/^([^=\s]+)=/)?.[1])
			.filter((name): name is string => Boolean(name))
			.sort();
		aliasNames = [...new Set(names)];
	} catch {
		aliasNames = [];
	}
	return aliasNames;
}

function readLog(): string {
	try {
		const text = fs.readFileSync(rcLogPath, "utf8").trim();
		return text ? `rc stderr (${rcLogPath}):\n${text.split("\n").slice(-20).join("\n")}` : `rc stderr: clean (${rcLogPath})`;
	} catch {
		return `no rc log yet (${rcLogPath}) — nothing has been written to stderr by your rc`;
	}
}

/* ------------------------------------------------------------------ *
 * Init + wrapper generation
 * ------------------------------------------------------------------ */

function init(): void {
	// Session-scoped toggles survive init(); only the environment is re-read.
	if (process.env.PI_ZSH_BASH === "0" || process.env.PI_ZSH_BASH === "off") enabled = false;
	const envMode = process.env.PI_ZSH_BASH_MODE;
	if (envMode === "interactive" || envMode === "rc") mode = envMode;

	const home = os.homedir();
	disabledReason = undefined;
	zshBin = findZsh();

	const zdot = process.env.ZDOTDIR?.trim() || home;
	rcFile = path.join(zdot, ".zshrc");
	if (!fs.existsSync(rcFile) && zdot !== home) rcFile = path.join(home, ".zshrc");

	const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || path.join(home, ".cache");
	const dir = path.join(cacheRoot, "pi", "zsh-bash");
	wrapperPath = path.join(dir, "pi-zsh");
	rcLogPath = path.join(dir, "rc.log");
	zdotDir = path.join(dir, "zdot");

	if (!zshBin) {
		disabledReason = "zsh not found on PATH";
		return;
	}
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
		writeWrapper();
		if (mode === "interactive") writePrivateZdot();
	} catch (error) {
		disabledReason = `could not write ${dir}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function findZsh(): string | null {
	const override = process.env.PI_ZSH_BIN?.trim();
	if (override) return isExecutable(override) ? override : null;
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "zsh");
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** Only rewrite on change, so concurrent pi sessions do not fight over mtime. */
function writeFileIfChanged(file: string, content: string, mode?: number): void {
	try {
		if (fs.readFileSync(file, "utf8") === content) return;
	} catch {
		// missing or unreadable: fall through and write it
	}
	fs.writeFileSync(file, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
}

function writeWrapper(): void {
	writeFileIfChanged(wrapperPath, wrapperScript(), 0o755);
	// A wrapper without the exec bit is a hard failure for every command, and
	// writeFileIfChanged skips rewriting an unchanged file that lost the bit.
	fs.chmodSync(wrapperPath, 0o755);
}

function wrapperScript(): string {
	const zsh = shellString(zshBin ?? "zsh");
	const rc = shellString(rcFile);
	const log = shellString(rcLogPath);
	const zdot = shellString(zdotDir);

	if (mode === "interactive") {
		return `#!/usr/bin/env zsh
# pi-zsh-bash wrapper (interactive mode) — generated, do not edit.
# Run as: pi-zsh '<command>'   or   pi-zsh -c '<command>'

# Private ZDOTDIR: this .zshrc turns the real one on inside a genuinely
# interactive shell, with history expansion and history writes off.
export ZDOTDIR=${zdot}
export HISTFILE=/dev/null

cmd=$1
[[ $1 == -c ]] && cmd=$2

exec ${zsh} -i -c 'eval -- "$1"' pi-zsh-bash "$cmd"
`;
	}

	return `#!/usr/bin/env zsh
# pi-zsh-bash wrapper (rc mode) — generated, do not edit.
# Run as: pi-zsh '<command>'   or   pi-zsh -c '<command>'

# .zshenv is already read: non-interactive zsh does that on its own. .zshrc is
# interactive-only, so read it here. Its stdout is dropped (banners, ascii art
# would otherwise prefix every command's output); its stderr goes to a log.
if [[ -r ${rc} ]]; then
\t{ source ${rc} >/dev/null } 2>>${log}
fi

cmd=$1
[[ $1 == -c ]] && cmd=$2

# eval re-parses the command, so zsh syntax, pipes, heredocs, multiline scripts
# and a bare "exit N" all behave exactly as they would in a plain zsh -c.
eval -- "$cmd"
exit $?
`;
}

/**
 * A ZDOTDIR whose rc makes zsh interactive *and* loads the real one quietly.
 * Only used by interactive mode; written lazily so rc mode leaves no trace.
 */
function writePrivateZdot(): void {
	fs.mkdirSync(zdotDir, { recursive: true, mode: 0o755 });
	writeFileIfChanged(
		path.join(zdotDir, ".zshenv"),
		`# pi-zsh-bash private ZDOTDIR — generated, do not edit.
export HISTFILE=/dev/null
unsetopt share_history append_history inc_append_history 2>/dev/null
`,
	);
	writeFileIfChanged(
		path.join(zdotDir, ".zshrc"),
		`# pi-zsh-bash private ZDOTDIR — generated, do not edit.
# Bang history would break ordinary commands ("echo done!" -> event not found).
unsetopt bang_hist 2>/dev/null
if [[ -r ${shellString(rcFile)} ]]; then
\t{ source ${shellString(rcFile)} >/dev/null } 2>>${shellString(rcLogPath)}
fi
`,
	);
}

/** POSIX single-quoting: safe for any byte except NUL. */
function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** zsh single-quoting, for embedding paths into the generated wrapper. */
function shellString(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
