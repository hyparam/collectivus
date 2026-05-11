export interface RendezvousStore {
  /** Filesystem root for rendezvous state. */
  dataDir: string
  /** Directory containing one `<sha256(join_code)>.json` invite per active/expired join code. */
  invitesDir: string
  /** Millisecond clock used for expiry checks. */
  now(): number
}

export interface RendezvousInviteRecord {
  /** SHA-256 hex of the plaintext join code. The plaintext join code is never stored. */
  join_code_hash: string
  /** Gateway-reachable Central server base URL. */
  connect_url: string
  /** Gateway identity the customer Central server will issue for this invite. */
  gateway_id: string
  /** Invite expiration as an ISO-8601 timestamp. */
  expires_at: string
  /** Invite creation timestamp as ISO-8601. */
  created_at: string
  /** Optional operator-facing display metadata. */
  display_name?: string
}

export interface RegisterInviteInput {
  join_code_hash: string
  connect_url: string
  gateway_id: string
  expires_at: string
  display_name?: string
}

export type RendezvousStoreErrorCode =
  | 'duplicate_active'
  | 'expired'
  | 'invalid_connect_url'
  | 'invalid_display_name'
  | 'invalid_expires_at'
  | 'invalid_gateway_id'
  | 'invalid_join_code'
  | 'invalid_join_code_hash'
  | 'invalid_record'
  | 'unknown_join_code'
