export interface Config {
  group_whitelist: string[]
  private_whitelist: string[]
  reply_in_disabled_groups: boolean
  cnb_repository: string
  cnb_token: string
  cnb_api_endpoint: string
  cnb_web_endpoint: string
  npc_mention: string
  npc_author_ids: string[]
  npc_author_usernames: string[]
  assistant_name: string
  log_location_hint: string
  log_wait_minutes: number
  analysis_wait_minutes: number
  recovery_confirm_minutes: number
  max_log_file_mib: number
  poll_interval_seconds: number
  issue_check_interval_seconds: number
  delivery_send_timeout_seconds: number
  max_delivery_attempts: number
  file_url_host_allowlist: string[]
  history_retention_days: number
}

export interface Scope {
  platform: string
  bot_id: string
  guild_id: string
  channel_id: string
  user_id: string
  direct: boolean
}

export type Status =
  | 'WAITING_LOG'
  | 'PREPARING_LOG'
  | 'CREATING_ISSUE'
  | 'TRIGGERING_NPC'
  | 'WAITING_NPC'
  | 'DELIVERING'
  | 'AWAITING_RECOVERY'
  | 'CLOSING_ISSUE'
  | 'UNCERTAIN'
  | 'DONE'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED'

export interface Report {
  id: string
  active_key: string | null
  status: Status
  platform: string
  bot_id: string
  guild_id: string
  channel_id: string
  user_id: string
  direct: boolean
  created_at: number
  updated_at: number
  deadline: number
  log_prompt_message_ids?: string[]
  source_message_id?: string
  revision?: number
  [key: string]: any
}
