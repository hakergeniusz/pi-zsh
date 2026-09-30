# pi-zsh (zsh-bash)

A single-file [Pi](https://github.com/earendil-works/pi) extension that makes
pi's `bash` tool actually run **zsh**, with your real `.zshrc` loaded.

Pi hardcodes `/bin/bash` for the bash tool, and bash never reads `.zshrc` — so
everything that lives there (consolidated `PATH`, `alias ls=eza`, `grep=rg`,
`cat=bat`, custom functions, `PNPM_HOME`, …) was invisible to the agent while
being plainly available to the human in the same terminal. This extension
closes that gap: every bash tool call is routed through a small zsh wrapper
that sources your `.zshrc` first.

## Install

```sh
ln -s "$PWD/zsh-bash.ts" ~/.pi/agent/extensions/zsh-bash.ts
```

(or copy the file there). Restart pi.

## How it works

Pi builds its bash tool once at session creation from settings an extension
cannot reach, so the shell cannot be swapped from inside the tool. Two
supported hooks get there instead:

- **`tool_call`** for the model-facing tool: the command is rewritten to
  `<wrapper> '<command>'`. The wrapper re-parses it with `eval`, so zsh syntax,
  pipes, heredocs and multiline scripts survive intact, and the single-quote
  wrapping is byte-safe for any input without NUL.
- **`user_bash`** for your own `!command`: pi accepts replacement
  `operations`, so the command is handed to pi's standard local execution
  backend with `shellPath` pointing at the same wrapper. No quoting at all.

One stable system-prompt bullet tells the model the shell is zsh with your rc
loaded (including the live alias list), so it writes zsh and expects the rc.

## Modes

- **`rc`** (default): a non-interactive zsh that `source`s `.zshrc`.
  Interactive guards such as `[[ -o interactive ]] && return` skip the
  TTY-only parts — which is what you want for a command run, and it keeps
  stray prompt/banner output out of the result.
- **`interactive`**: `zsh -i` against a private `ZDOTDIR` whose `.zshrc`
  sources yours, for rc files that bail out early unless the shell is
  interactive. History expansion (`!`) and history writes are disabled there,
  because `echo done!` must not turn into "event not found".

Either way the rc's stdout is discarded — otherwise a greeting/banner in the rc
would be prepended to the output of every single command — and its stderr goes
to `<cache>/pi/zsh-bash/rc.log`.

## Commands

    /zsh-bash status | on | off | rc | interactive | log | aliases

## Environment

- `PI_ZSH_BASH=0` — disable for a session
- `PI_ZSH_BASH_MODE=interactive` — pick the mode
- `PI_ZSH_BIN=/path/to/zsh` — override zsh discovery

## Note on secrets

Sourcing `.zshrc` also sources whatever *it* sources. If your rc pulls in
`~/.zsh_secrets`, shell commands run by the agent inherit those variables. Use
`/zsh-bash off` (or `PI_ZSH_BASH=0`) if that is not wanted.
