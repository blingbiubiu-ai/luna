/**
 * Describes the Message Receive Event Data contract used by Feishu message transport.
 */
export interface MessageReceiveEventData {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender: {
    sender_id?: {
      app_id?: string;
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
    name?: string;
    display_name?: string;
    nickname?: string;
    avatar_url?: string;
    avatar?: Record<string, unknown>;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: "p2p" | "group" | string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name?: string;
      mentioned_type?: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

export interface FeishuBotAddedToGroupEventData {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  chat_id?: string;
  operator_id?: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  external?: boolean;
  operator_tenant_key?: string;
  name?: string;
  i18n_names?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
}

export interface FeishuHistoryMessageMentionRecord {
  key?: string;
  id?: string;
  id_type?: string;
  name?: string;
  tenant_key?: string;
}

export interface FeishuHistoryMessageRecord {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  deleted?: boolean;
  updated?: boolean;
  chat_id?: string;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    tenant_key?: string;
    sender_name?: string;
  };
  body?: {
    content?: string;
  };
  mentions?: FeishuHistoryMessageMentionRecord[];
  upper_message_id?: string;
  message_app_link?: string;
  message_position?: string;
  thread_message_position?: string;
}
