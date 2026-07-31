# Altair History

Undo and redo for Altair projects, documents, and editor workspaces.

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-history
```

```ts
import { altairHistoryPlugin, altairHistoryServiceKey } from "@haneoka/altair-plugin-history";

await host.install(altairHistoryPlugin);
const history = host.service(altairHistoryServiceKey)?.create("project", project);
history?.update((draft) => updateProject(draft));
history?.undo();
```

Snapshots contain JSON data only. Consecutive updates can share a merge key so a single editing gesture produces one undo step.

MPL-2.0.
