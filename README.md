# Altair History

Altair History is the undo and redo behind the
[Altair](https://github.com/haneoka-gakuen/altair) editor. It keeps a bounded
stack of snapshots for anything you edit — a whole story project, one source
document, or the complete editor workspace — and hands back frozen copies, so
a value from the history can never be changed by accident. A drag, a run of
keystrokes or an IME composition can be folded into a single undo step.

It works for any JSON data, so you can use it for your own editor as well.

## Install

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-history
```

ESM only; Node 20 or a current browser.

## Use it in Altair

```ts
import { AltairPluginHost } from "@haneoka/altair/plugins";
import { altairHistoryPlugin, altairHistoryServiceKey } from "@haneoka/altair-plugin-history";

const host = new AltairPluginHost();
await host.install(altairHistoryPlugin);

const histories = host.service(altairHistoryServiceKey);
const history = histories.create("project", project);
```

The plugin (`haneoka.altair-history`) provides one service; it adds no UI of
its own. The editor binds the usual shortcuts to it.

## Editing with history

```ts
// Change a draft in place, or return a new value.
history.update((draft) => {
  draft.scenes[0].name = "Opening";
});

// Replace the whole value.
history.replace(loadedProject);

history.undo();
history.redo();

history.canUndo;  // boolean
history.undoDepth; // number of steps back
history.value;    // the current value, deeply frozen
```

`update` receives a mutable copy; the stored value is only replaced when the
updater finishes, so an exception leaves the history unchanged. Every change
increases `revision`, which makes it a cheap dirty check.

### One gesture, one step

Give consecutive changes the same `mergeKey` and they become one undo step.
End the gesture with `endMerge()`:

```ts
slider.addEventListener("input", () =>
  history.update((draft) => { draft.volume = slider.valueAsNumber; }, { mergeKey: "volume" }),
);
slider.addEventListener("change", () => history.endMerge());
```

A different key, or a change without a key, also ends the merge.

### Starting over

`reset(value)` sets a new value and clears both stacks — use it after opening
another file. `snapshot()` returns the value together with `revision`,
`canUndo`, `canRedo`, `undoDepth` and `redoDepth` in one object.

## The service

| Member | Description |
| --- | --- |
| `create(name, initialValue, { capacity }?)` | A new named history. The value is checked to be JSON before anything is stored. |
| `get(name)` / `has(name)` / `names()` | Look up existing histories. |
| `close(name)` | Dispose one history. |
| `size` | Number of open histories. |
| `dispose()` | Dispose all of them. |

`capacity` defaults to `ALTAIR_HISTORY_DEFAULT_CAPACITY` (100) undo steps and
must be an integer from 1 to `ALTAIR_HISTORY_MAX_CAPACITY` (1 000); anything
else throws a `RangeError`. The oldest step is dropped when the stack is full.

Snapshots must be plain JSON: objects, arrays, strings, finite numbers,
booleans and `null`, nested at most 256 levels and at most one million values
in total. Anything else — functions, `undefined`, `Map`, class instances,
cycles — is rejected with a `TypeError` that names the offending path. You can
run the same check yourself with `assertAltairJsonSnapshot(value)`.

Without the plugin host, `createAltairHistoryService()` returns the same
service.

## License

MPL-2.0. See [LICENSE](LICENSE).
