CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  project_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT 'Untitled',
  summary TEXT,
  host TEXT NOT NULL DEFAULT 'native',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  user_input TEXT,
  assistant_response TEXT,
  message_count INTEGER DEFAULT 0,
  tool_execution_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  source TEXT NOT NULL DEFAULT 'assistant_text',
  sequence INTEGER DEFAULT 0,
  role TEXT NOT NULL,
  content_text TEXT,
  content_thinking TEXT,
  content_tool_name TEXT,
  content_tool_input TEXT,
  content_tool_output TEXT,
  is_sidechain INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  sequence INTEGER DEFAULT 0,
  tool_use_message_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  outcome TEXT DEFAULT 'pending',
  input_summary TEXT,
  output_summary TEXT,
  is_error INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE TABLE subagent_links (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT,
  agent_id TEXT,
  agent_role TEXT,
  slug TEXT,
  file_path TEXT,
  message_count INTEGER DEFAULT 0,
  spawned_at INTEGER
);

CREATE TABLE session_digests (
  session_id TEXT PRIMARY KEY,
  host TEXT,
  platform TEXT,
  one_liner TEXT,
  key_topics TEXT,
  key_files TEXT,
  decisions TEXT,
  open_questions TEXT,
  embedding BLOB,
  embedding_status TEXT NOT NULL DEFAULT 'none',
  access_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  content_thinking,
  content_tool_name,
  content_tool_input,
  content_tool_output,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE sessions_fts USING fts5(
  title,
  summary,
  content='work_sessions',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER msg_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(
    rowid,
    content_text,
    content_thinking,
    content_tool_name,
    content_tool_input,
    content_tool_output
  ) VALUES (
    new.rowid,
    new.content_text,
    new.content_thinking,
    new.content_tool_name,
    new.content_tool_input,
    new.content_tool_output
  );
END;

CREATE TRIGGER ws_fts_insert AFTER INSERT ON work_sessions BEGIN
  INSERT INTO sessions_fts(rowid, title, summary)
  VALUES (new.rowid, new.title, new.summary);
END;
