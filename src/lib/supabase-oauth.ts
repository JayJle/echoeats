import { supabase } from "@/integrations/supabase/client";

export type OAuthDetails = {
  client?: { name?: string | null } | null;
  redirect_url?: string | null;
  redirect_to?: string | null;
};

type OAuthResult = { data: OAuthDetails | null; error: { message: string } | null };

type OAuthApi = {
  getAuthorizationDetails: (id: string) => Promise<OAuthResult>;
  approveAuthorization: (id: string) => Promise<OAuthResult>;
  denyAuthorization: (id: string) => Promise<OAuthResult>;
};

// `supabase.auth.oauth` is a beta namespace not yet in the generated types.
export function supabaseOAuth(): OAuthApi {
  return (supabase.auth as unknown as { oauth: OAuthApi }).oauth;
}
