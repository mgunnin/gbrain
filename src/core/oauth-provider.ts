/**
 * GBrain OAuth 2.1 Provider — implements MCP SDK's OAuthServerProvider.
 *
 * Backed by raw SQL (PGLite or Postgres), not the BrainEngine interface.
 * OAuth is infrastructure, not brain operations.
 *
 * Supports:
 * - Client registration (manual via CLI or Dynamic Client Registration)
 * - Authorization code flow with PKCE (for ChatGPT, browser-based clients)
 * - Client credentials flow (for machine-to-machine: Perplexity, Claude)
 * - Token refresh with rotation
 * - Token revocation
 * - Legacy access_tokens fallback for backward compat
 */

import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { hashToken, generateToken } from './utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw SQL query function — works with both PGLite and postgres tagged templates */
type SqlQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/** Convert a JS array to PostgreSQL array literal for PGLite compat */
function pgArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '{}';
  return `{${arr.join(',')}}`;
}

interface GBrainOAuthProviderOptions {
  sql: SqlQuery;
  /** Default token TTL in seconds (default: 3600 = 1 hour) */
  tokenTtl?: number;
  /** Default refresh token TTL in seconds (default: 30 days) */
  refreshTtl?: number;
}

// ---------------------------------------------------------------------------
// Clients Store
// ---------------------------------------------------------------------------

class GBrainClientsStore implements OAuthRegisteredClientsStore {
  constructor(private sql: SqlQuery) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const rows = await this.sql`
      SELECT client_id, client_secret_hash, client_name, redirect_uris,
             grant_types, scope, token_endpoint_auth_method,
             client_id_issued_at, client_secret_expires_at
      FROM oauth_clients WHERE client_id = ${clientId}
    `;
    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      client_id: r.client_id as string,
      client_secret: r.client_secret_hash as string | undefined,
      client_name: r.client_name as string,
      redirect_uris: (r.redirect_uris as string[]) || [],
      grant_types: (r.grant_types as string[]) || ['client_credentials'],
      scope: r.scope as string | undefined,
      token_endpoint_auth_method: r.token_endpoint_auth_method as string | undefined,
      client_id_issued_at: r.client_id_issued_at as number | undefined,
      client_secret_expires_at: r.client_secret_expires_at as number | undefined,
    };
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const clientId = generateToken('gbrain_cl_');
    const clientSecret = generateToken('gbrain_cs_');
    const secretHash = hashToken(clientSecret);
    const now = Math.floor(Date.now() / 1000);

    await this.sql`
      INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                  grant_types, scope, token_endpoint_auth_method,
                                  client_id_issued_at)
      VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
              ${pgArray((client.redirect_uris || []).map(String))},
              ${pgArray(client.grant_types || ['client_credentials'])},
              ${client.scope || ''}, ${client.token_endpoint_auth_method || 'client_secret_post'},
              ${now})
    `;

    return {
      ...client,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: now,
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

export class GBrainOAuthProvider implements OAuthServerProvider {
  private sql: SqlQuery;
  private _clientsStore: GBrainClientsStore;
  private tokenTtl: number;
  private refreshTtl: number;

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this._clientsStore = new GBrainClientsStore(this.sql);
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  // -------------------------------------------------------------------------
  // Authorization Code Flow
  // -------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = generateToken('gbrain_code_');
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minute TTL

    await this.sql`
      INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                code_challenge_method, redirect_uri, state, resource, expires_at)
      VALUES (${codeHash}, ${client.client_id},
              ${pgArray(params.scopes || [])},
              ${params.codeChallenge}, ${'S256'},
              ${params.redirectUri}, ${params.state || null},
              ${params.resource?.toString() || null}, ${expiresAt})
    `;

    // Redirect back with the code
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) redirectUrl.searchParams.set('state', params.state);
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    const rows = await this.sql`
      SELECT code_challenge FROM oauth_codes
      WHERE code_hash = ${codeHash} AND expires_at > ${Math.floor(Date.now() / 1000)}
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');
    return rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    // Fetch and delete the code (single-use)
    const rows = await this.sql`
      SELECT client_id, scopes, resource FROM oauth_codes
      WHERE code_hash = ${codeHash} AND expires_at > ${now}
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');

    const codeRow = rows[0];
    if (codeRow.client_id !== client.client_id) throw new Error('Client mismatch');

    // Delete the used code
    await this.sql`DELETE FROM oauth_codes WHERE code_hash = ${codeHash}`;

    // Issue tokens
    const scopes = (codeRow.scopes as string[]) || [];
    return this.issueTokens(client.client_id, scopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Refresh Token
  // -------------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    const rows = await this.sql`
      SELECT client_id, scopes, expires_at FROM oauth_tokens
      WHERE token_hash = ${tokenHash} AND token_type = 'refresh'
    `;
    if (rows.length === 0) throw new Error('Refresh token not found');

    const row = rows[0];
    if (row.client_id !== client.client_id) throw new Error('Client mismatch');
    if ((row.expires_at as number) < now) throw new Error('Refresh token expired');

    // Rotate: delete old refresh token
    await this.sql`DELETE FROM oauth_tokens WHERE token_hash = ${tokenHash}`;

    const tokenScopes = scopes || (row.scopes as string[]) || [];
    return this.issueTokens(client.client_id, tokenScopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Try OAuth tokens first
    const oauthRows = await this.sql`
      SELECT client_id, scopes, expires_at, resource FROM oauth_tokens
      WHERE token_hash = ${tokenHash} AND token_type = 'access'
    `;

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      if ((row.expires_at as number) < now) {
        throw new Error('Token expired');
      }
      return {
        token,
        clientId: row.client_id as string,
        scopes: (row.scopes as string[]) || [],
        expiresAt: row.expires_at as number,
        resource: row.resource ? new URL(row.resource as string) : undefined,
      };
    }

    // Fallback: legacy access_tokens table (backward compat)
    const legacyRows = await this.sql`
      SELECT name FROM access_tokens
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `;

    if (legacyRows.length > 0) {
      // Legacy tokens get full admin access (grandfather in)
      // Update last_used_at
      await this.sql`
        UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${tokenHash}
      `;
      return {
        token,
        clientId: legacyRows[0].name as string,
        scopes: ['read', 'write', 'admin'],
      };
    }

    throw new Error('Invalid token');
  }

  // -------------------------------------------------------------------------
  // Token Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    await this.sql`DELETE FROM oauth_tokens WHERE token_hash = ${tokenHash}`;
  }

  // -------------------------------------------------------------------------
  // Client Credentials (called by custom handler, not SDK)
  // -------------------------------------------------------------------------

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Client not found');

    // Check grant type first (before verifying secret)
    const grants = (client.grant_types as string[]) || [];
    if (!grants.includes('client_credentials')) {
      throw new Error('Client credentials grant not authorized for this client');
    }

    // Verify secret
    const secretHash = hashToken(clientSecret);
    if (client.client_secret !== secretHash) throw new Error('Invalid client secret');

    // Determine scopes
    const allowedScopes = (client.scope || '').split(' ').filter(Boolean);
    const requestedScopes = requestedScope ? requestedScope.split(' ').filter(Boolean) : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => allowedScopes.includes(s));

    // Client credentials: access token only, NO refresh token (RFC 6749 4.4.3)
    return this.issueTokens(clientId, grantedScopes, undefined, false);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.sql`
      DELETE FROM oauth_tokens WHERE expires_at < ${now}
    `;
    const deletedCodes = await this.sql`
      DELETE FROM oauth_codes WHERE expires_at < ${now}
    `;
    return (result as any).count || 0;
  }

  // -------------------------------------------------------------------------
  // CLI Registration Helper
  // -------------------------------------------------------------------------

  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string,
    redirectUris: string[] = [],
  ): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = generateToken('gbrain_cl_');
    const clientSecret = generateToken('gbrain_cs_');
    const secretHash = hashToken(clientSecret);
    const now = Math.floor(Date.now() / 1000);

    await this.sql`
      INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                  grant_types, scope, client_id_issued_at)
      VALUES (${clientId}, ${secretHash}, ${name},
              ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${now})
    `;

    return { clientId, clientSecret };
  }

  // -------------------------------------------------------------------------
  // Internal: Issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
  ): Promise<OAuthTokens> {
    const accessToken = generateToken('gbrain_at_');
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const accessExpiry = now + this.tokenTtl;

    await this.sql`
      INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
      VALUES (${accessHash}, ${'access'}, ${clientId},
              ${pgArray(scopes)}, ${accessExpiry}, ${resource?.toString() || null})
    `;

    const result: OAuthTokens = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.tokenTtl,
      scope: scopes.join(' '),
    };

    if (includeRefresh) {
      const refreshToken = generateToken('gbrain_rt_');
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = now + this.refreshTtl;

      await this.sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
        VALUES (${refreshHash}, ${'refresh'}, ${clientId},
                ${pgArray(scopes)}, ${refreshExpiry}, ${resource?.toString() || null})
      `;

      result.refresh_token = refreshToken;
    }

    return result;
  }
}
