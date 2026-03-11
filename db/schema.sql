-- Key management table
CREATE TABLE IF NOT EXISTS user_keys (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_keys_created_at ON user_keys(created_at DESC);

-- Core fortune call records (for storage/replay/audit)
CREATE TABLE IF NOT EXISTS fortune_records (
  id BIGSERIAL PRIMARY KEY,
  key_ref TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('bazi', 'meihua')),
  question TEXT,
  input_payload JSONB NOT NULL,
  output_text TEXT NOT NULL,
  credits_after INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fortune_records_key_ref ON fortune_records(key_ref);
CREATE INDEX IF NOT EXISTS idx_fortune_records_created_at ON fortune_records(created_at DESC);
