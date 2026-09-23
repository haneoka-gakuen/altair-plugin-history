import { cloneStoryValue, type JsonValue } from "@haneoka/altair/model";
import { defineAltairPlugin, defineAltairService } from "@haneoka/altair/plugins";

export const ALTAIR_HISTORY_PLUGIN_ID = "haneoka.altair-history";
export const ALTAIR_HISTORY_SERVICE_ID = "haneoka.altair.history";
export const ALTAIR_HISTORY_DEFAULT_CAPACITY = 100;
export const ALTAIR_HISTORY_MAX_CAPACITY = 1_000;

export type Immutable<T> = T extends (...arguments_: never[]) => unknown
  ? never
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T;

export type Mutable<T> = T extends (...arguments_: never[]) => unknown
  ? never
  : T extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

export interface AltairHistoryUpdateOptions {
  /**
   * Consecutive changes with the same key form one undoable editing gesture.
   * Call `endMerge()` when a pointer, key, or composition gesture ends.
   */
  readonly mergeKey?: string;
}

export interface AltairHistoryOptions {
  readonly capacity?: number;
}

export interface AltairHistorySnapshot<T> {
  readonly value: Immutable<T>;
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

/**
 * A bounded history for one JSON-compatible authoring snapshot.
 *
 * `T` can be a StoryProject, a source document, or a complete Studio
 * workspace. Values returned by this interface are deeply frozen clones.
 */
export interface AltairHistory<T> {
  readonly name: string;
  readonly capacity: number;
  readonly disposed: boolean;
  readonly value: Immutable<T>;
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  snapshot(): AltairHistorySnapshot<T>;
  update(
    updater: (draft: Mutable<T>) => T | Mutable<T> | Immutable<T> | void,
    options?: AltairHistoryUpdateOptions,
  ): Immutable<T>;
  replace(value: T | Mutable<T> | Immutable<T>, options?: AltairHistoryUpdateOptions): Immutable<T>;
  endMerge(): void;
  undo(): Immutable<T>;
  redo(): Immutable<T>;
  reset(value: T | Mutable<T> | Immutable<T>): Immutable<T>;
  dispose(): void;
}

export interface AltairHistoryService {
  readonly disposed: boolean;
  readonly size: number;
  /** `initialValue` is validated as JSON before the named history is created. */
  create<T>(name: string, initialValue: T, options?: AltairHistoryOptions): AltairHistory<T>;
  /**
   * Supply `T` when retrieving a named history after its creation.
   * Holding the result of `create()` avoids this lookup assertion.
   */
  get<T = JsonValue>(name: string): AltairHistory<T> | undefined;
  has(name: string): boolean;
  names(): readonly string[];
  close(name: string): boolean;
  dispose(): void;
}

export const altairHistoryServiceKey = defineAltairService<AltairHistoryService>(ALTAIR_HISTORY_SERVICE_ID);

const MAX_JSON_DEPTH = 256;
const MAX_JSON_NODES = 1_000_000;

const invalidSnapshot = (path: string, reason: string): never => {
  throw new TypeError(`Altair history snapshot is not JSON-compatible at ${path}: ${reason}`);
};

/**
 * Enforces the JSON-only persistence boundary at runtime for JavaScript,
 * erased TypeScript types, editor proxies and plugin callers.
 */
export const assertAltairJsonSnapshot: (value: unknown) => asserts value is JsonValue = (value) => {
  let nodes = 0;
  const active = new WeakSet<object>();

  const visit = (current: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      invalidSnapshot(path, "snapshot is too large");
    }
    if (depth > MAX_JSON_DEPTH) {
      invalidSnapshot(path, "snapshot is too deeply nested");
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        invalidSnapshot(path, "numbers must be finite");
      }
      return;
    }
    if (typeof current !== "object") {
      invalidSnapshot(path, `${typeof current} values are not supported`);
    }

    const object = current as object;
    if (active.has(object)) {
      invalidSnapshot(path, "cyclic references are not supported");
    }
    active.add(object);
    try {
      if (Array.isArray(current)) {
        for (const key of Reflect.ownKeys(current)) {
          if (typeof key !== "string") {
            invalidSnapshot(path, "symbol properties are not supported");
            continue;
          }
          if (key === "length") continue;
          if (!/^(?:0|[1-9]\d*)$/u.test(key)) {
            invalidSnapshot(path, `array property ${key} is not supported`);
          }
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (descriptor === undefined) {
            invalidSnapshot(`${path}[${index}]`, "sparse arrays are not supported");
            continue;
          }
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            invalidSnapshot(`${path}[${index}]`, "array items must be enumerable data values");
            continue;
          }
          visit(descriptor.value, `${path}[${index}]`, depth + 1);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        invalidSnapshot(path, "only plain objects are supported");
      }
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key !== "string") {
          invalidSnapshot(path, "symbol properties are not supported");
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          invalidSnapshot(`${path}.${key}`, "properties must be enumerable data values");
          continue;
        }
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    } finally {
      active.delete(object);
    }
  };

  visit(value, "$", 0);
};

const freezeDeep = <T>(value: T, seen: WeakSet<object> = new WeakSet()): Immutable<T> => {
  if (value === null || typeof value !== "object") {
    return value as Immutable<T>;
  }
  const object = value as object;
  if (seen.has(object)) return value as Immutable<T>;
  seen.add(object);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
  } else {
    for (const item of Object.values(value)) freezeDeep(item, seen);
  }
  return Object.freeze(value) as Immutable<T>;
};

const immutableSnapshotClone = <T>(value: unknown): Immutable<T> => {
  assertAltairJsonSnapshot(value);
  return freezeDeep(cloneStoryValue(value) as unknown as T);
};

const mutableSnapshotClone = <T>(value: Immutable<T>): Mutable<T> => cloneStoryValue(value) as unknown as Mutable<T>;

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object" || Array.isArray(right)) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]));
};

const requireCapacity = (capacity: number | undefined): number => {
  const value = capacity ?? ALTAIR_HISTORY_DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(value) || value < 1 || value > ALTAIR_HISTORY_MAX_CAPACITY) {
    throw new RangeError(`Altair history capacity must be an integer from 1 to ${ALTAIR_HISTORY_MAX_CAPACITY}`);
  }
  return value;
};

const requireName = (name: string): string => {
  if (typeof name !== "string") {
    throw new TypeError("Altair history name must be a string");
  }
  const value = name.trim();
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Altair history name must contain 1 to 128 printable characters");
  }
  return value;
};

const mergeKey = (options: AltairHistoryUpdateOptions | undefined): string | undefined => {
  if (options === undefined || options.mergeKey === undefined) {
    return undefined;
  }
  if (typeof options.mergeKey !== "string") {
    throw new TypeError("Altair history merge key must be a string");
  }
  const value = options.mergeKey.trim();
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Altair history merge key must contain 1 to 256 printable characters");
  }
  return value;
};

class BoundedJsonHistory<T> implements AltairHistory<T> {
  readonly name: string;
  readonly capacity: number;

  #present: Immutable<T> | undefined;
  #undo: Immutable<T>[] = [];
  #redo: Immutable<T>[] = [];
  #mergeKey: string | undefined;
  #revision = 0;
  #disposed = false;

  constructor(name: string, initialValue: unknown, capacity: number) {
    this.name = name;
    this.capacity = capacity;
    this.#present = immutableSnapshotClone<T>(initialValue);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get value(): Immutable<T> {
    return immutableSnapshotClone<T>(this.#requirePresent());
  }

  get revision(): number {
    this.#assertActive();
    return this.#revision;
  }

  get canUndo(): boolean {
    this.#assertActive();
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    this.#assertActive();
    return this.#redo.length > 0;
  }

  get undoDepth(): number {
    this.#assertActive();
    return this.#undo.length;
  }

  get redoDepth(): number {
    this.#assertActive();
    return this.#redo.length;
  }

  snapshot(): AltairHistorySnapshot<T> {
    this.#assertActive();
    return Object.freeze({
      value: this.value,
      revision: this.#revision,
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
    });
  }

  update(
    updater: (draft: Mutable<T>) => T | Mutable<T> | Immutable<T> | void,
    options?: AltairHistoryUpdateOptions,
  ): Immutable<T> {
    this.#assertActive();
    if (typeof updater !== "function") {
      throw new TypeError("Altair history updater must be a function");
    }
    const gesture = mergeKey(options);
    const current = this.#requirePresent();
    const draft = mutableSnapshotClone(current);
    const returned = updater(draft);
    const next = immutableSnapshotClone<T>(returned ?? draft);
    if (sameValue(next, current)) return this.value;

    const mergesWithPrevious = gesture !== undefined && gesture === this.#mergeKey && this.#redo.length === 0;
    if (!mergesWithPrevious) {
      this.#undo.push(current);
      if (this.#undo.length > this.capacity) {
        this.#undo.splice(0, this.#undo.length - this.capacity);
      }
    }
    this.#present = next;
    this.#redo.length = 0;
    this.#mergeKey = gesture;
    this.#revision += 1;
    return this.value;
  }

  replace(value: T | Mutable<T> | Immutable<T>, options?: AltairHistoryUpdateOptions): Immutable<T> {
    return this.update(() => value, options);
  }

  endMerge(): void {
    this.#assertActive();
    this.#mergeKey = undefined;
  }

  undo(): Immutable<T> {
    this.#assertActive();
    const previous = this.#undo.pop();
    if (previous === undefined) return this.value;
    this.#redo.push(this.#requirePresent());
    this.#present = previous;
    this.#mergeKey = undefined;
    this.#revision += 1;
    return this.value;
  }

  redo(): Immutable<T> {
    this.#assertActive();
    const next = this.#redo.pop();
    if (next === undefined) return this.value;
    this.#undo.push(this.#requirePresent());
    if (this.#undo.length > this.capacity) this.#undo.shift();
    this.#present = next;
    this.#mergeKey = undefined;
    this.#revision += 1;
    return this.value;
  }

  reset(value: T | Mutable<T> | Immutable<T>): Immutable<T> {
    this.#assertActive();
    const next = immutableSnapshotClone<T>(value);
    this.#present = next;
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#mergeKey = undefined;
    this.#revision += 1;
    return this.value;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#present = undefined;
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#mergeKey = undefined;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error(`Altair history is disposed: ${this.name}`);
    }
  }

  #requirePresent(): Immutable<T> {
    this.#assertActive();
    const present = this.#present;
    if (present === undefined) {
      throw new Error(`Altair history has no state: ${this.name}`);
    }
    return present;
  }
}

interface OwnedHistory {
  readonly disposed: boolean;
  dispose(): void;
}

class HistoryService implements AltairHistoryService {
  readonly #histories = new Map<string, OwnedHistory>();
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  get size(): number {
    this.#assertActive();
    return this.#histories.size;
  }

  create<T>(name: string, initialValue: T, options: AltairHistoryOptions = {}): AltairHistory<T> {
    this.#assertActive();
    const id = requireName(name);
    if (this.#histories.has(id)) {
      throw new Error(`Altair history already exists: ${id}`);
    }
    const history = new BoundedJsonHistory<T>(id, initialValue, requireCapacity(options.capacity));
    this.#histories.set(id, history);
    return history;
  }

  get<T = JsonValue>(name: string): AltairHistory<T> | undefined {
    this.#assertActive();
    return this.#histories.get(requireName(name)) as AltairHistory<T> | undefined;
  }

  has(name: string): boolean {
    this.#assertActive();
    return this.#histories.has(requireName(name));
  }

  names(): readonly string[] {
    this.#assertActive();
    return Object.freeze([...this.#histories.keys()].sort());
  }

  close(name: string): boolean {
    this.#assertActive();
    const id = requireName(name);
    const history = this.#histories.get(id);
    if (!history) return false;
    this.#histories.delete(id);
    history.dispose();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const history of this.#histories.values()) history.dispose();
    this.#histories.clear();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Altair history service is disposed");
    }
  }
}

export const createAltairHistoryService = (): AltairHistoryService => new HistoryService();

export const altairHistoryPlugin = defineAltairPlugin({
  manifest: {
    id: ALTAIR_HISTORY_PLUGIN_ID,
    name: "Altair History",
    version: "0.1.0",
    apiVersion: 2,
    description: "Bounded, immutable JSON snapshot undo and redo histories",
    capabilities: ["services"],
  },
  setup(context) {
    const service = context.use(createAltairHistoryService());
    context.provide(altairHistoryServiceKey, service);
  },
});

export default altairHistoryPlugin;
