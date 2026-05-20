# Set default language to English

Change the i18n default from Chinese to English in `src/lib/i18n/context.tsx`:

- `detectInitial()` SSR fallback: `"zh"` → `"en"`
- `useState<Lang>` initial value: `"zh"` → `"en"`

Behavior: New users (no saved preference, non-Chinese browser) get English. Users with `zh` browsers still auto-get Chinese. Saved preference in localStorage still wins.