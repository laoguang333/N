---
name: vue-composition-api
description: Vue 3 Composition API best practices — component structure, reactive state, composables, props/emits, and Vue + Vite conventions. Use when writing or refactoring Vue components.
license: MIT
compatibility: opencode
metadata:
  audience: frontend
  framework: vue
---

## When to use me
Use this skill when writing or refactoring Vue 3 `.vue` Single File Components (SFCs), creating composables, or defining component props/emits/models.

## Component Rules

### Use `<script setup>` exclusively
- Always use `<script setup>` — never Options API, never `export default {}`.
- Import all Vue APIs (`ref`, `computed`, `watch`, etc.) at the top.
- Lifecycle hooks (`onMounted`, `onBeforeUnmount`, etc.) are called directly in setup scope.

### Props, Emits, Model
- `defineProps(...)` — use the runtime declaration form for JS projects (no TypeScript generics).
- `defineEmits([...])` — declare emitted event names as an array of strings.
- `defineModel()` is available in Vue 3.4+ for v-model bindings.
- Props passed to the template use kebab-case in the parent, camelCase in `<script setup>`.

### Template conventions
- Keep templates clean — extract complex logic to computed properties or composables.
- Event bindings use kebab-case: `@click`, `@scroll.passive`, `@keydown`.
- Use `v-if`/`v-else` for conditional rendering, `v-for` with `:key` for lists.
- Template refs: use `ref(null)` and access via `.value` in `<script setup>`.

### One component per file
- Filename matches component name in PascalCase: `AutoScroll.vue`, `BookRow.vue`.
- Each `.vue` file contains one component only.

## Reactive State

### Use `reactive()` for grouped state objects
```js
const shelf = reactive({ books: [], search: "", status: "all" });
const reader = reactive({ loading: false, book: null, paragraphs: [] });
```

### Use `ref()` for primitives and DOM references
```js
const readerRoot = ref(null); // template ref
const playing = ref(false);   // primitive state
```

### Use `computed()` for derived values
```js
const bookProgress = computed(() => formatPercent(current / total));
```

### Use `watch()` and `watchEffect()` for side effects
- Deep-watchers for localStorage persistence.
- Debounced watchers for search/filter queries (setTimeout pattern).
- Watchers for route changes to trigger data loading.

## Composables

- Prefix composable filenames with `use`: `useAuth.js`, `useSearch.js`.
- Composables should encapsulate reactive state + related logic.
- Return `{ data, error, loading }` pattern for async composables.
- Place in `src/composables/` directory.

## API Conventions

- All server communication goes through a centralized `api.js` module.
- Use a single `request(path, options)` wrapper around `fetch`.
- GET functions named `get*()`, PUT named `save*()`, POST named `scan*()`.
- Always return parsed JSON; throw `Error` with server error message on failure.
- Read endpoints from `docs/api.md` before coding.

## Do NOT
- Generate Options API code (`data`, `methods`, `computed` as objects).
- Use `var` — always `const` or `let`.
- Mutate props directly.
- Use `v-html` with unsanitized user/source content.
- Put business logic directly in templates — use computed or composables.
