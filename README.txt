Linovelib v0.2.1 diagnostic patch for Mangayomi

Fix: choose first non-empty content node, prioritizing #acontent; improved error for JS-rendered empty text.
Does not yet fix catalog count or covers. Preserve Novel543 v0.3.0.
Upload to GitHub root novel543-mangayomi/main:
1. Replace existing linovelib.js with this version (keep exact filename)
2. Replace existing novel_index.json with this version to trigger 0.2.1 update
3. Refresh extensions and update Linovelib on Android/iOS
If still empty: use WebView for a chapter and share the exact error. Do not upload account cookies or password.
