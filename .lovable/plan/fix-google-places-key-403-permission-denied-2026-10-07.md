# Fix Google Places key (403 PERMISSION_DENIED)

## Finding
A direct test of the saved key against Places API (New) `places:searchText` returns `403 "The caller does not have permission"`. The key is present; Google is refusing it. All restaurant search, city checks and photos rely on this key, so they all fail.

## Likely causes (fix in Google Cloud Console, by you)
1. **"Places API (New)" not enabled** on the key's project (the old "Places API" alone is not enough).
2. **API restrictions** on the key do not include "Places API (New)".
3. **Application restrictions** set to HTTP referrers / IP addresses — server calls have no referrer and unpredictable IPs. Set to "None".
4. **Billing** disabled or card expired on the project.

## Steps
1. You check the four items above in Google Cloud Console.
2. If you create a new key, I open the secure form to replace `GOOGLE_PLACES_API_KEY`.
3. I re-run the same direct test and a real search to confirm a 200 response.

No code changes are needed.
