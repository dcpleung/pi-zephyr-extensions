# zephyr-limit-repeated-tool-calls

Nudges the model when it repeats a tool call with the same input and the same output.

Calls are keyed by tool name + input + result (content and error flag). A call counts as a
repeat when the same key appears among the last `window` tracked calls (default
10) since the last user prompt. Calls in between do not matter, so loops like
`a, b, c, a, b, c` are caught, while re-reading an unchanged file long after is not.
Input key order does not matter; a changed output is not a repeat. From the
second identical call on, a note is appended to the tool result saying nothing changed and
asking the model to use the result or change the input. From the third on, it also tells
the model to stop and ask the user if it is stuck. The tool still runs and its output is
kept. Calls issued by another tool (for example codemode scripts) are not tracked.

Settings (in `settings.json`, global or project, under `zephyrLimitRepeatedToolCalls`):

```json
{
  "zephyrLimitRepeatedToolCalls": {
    "enabled": true,
    "threshold": 2,
    "window": 10,
    "ignore": ["my_polling_tool"]
  }
}
```

Settings are read on every tool call, so edit `settings.json` and run `/reload` to apply
changes without restarting Pi.

- `threshold`: identical calls before the first nudge (default 2, minimum 2)
- `window`: how many recent calls to look at, including the current one
  (default 10, raised to at least the threshold; `0` = everything since the last user prompt).
  A loop of L calls reaches its k-th repeat inside the window only if (k − 1) × L + 1 ≤ window.
  With the defaults, loops of up to 9 calls get the first nudge and loops of up to 4 also get
  the stronger one.
- `ignore`: array of tool names to skip, for tools meant to be polled
- `enabled`: `false` turns the extension off

Defaults apply for any setting that is absent.
