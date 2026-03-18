CREATE TABLE IF NOT EXISTS quiz_leads (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  whatsapp VARCHAR(30) NOT NULL,
  instagram VARCHAR(100) NOT NULL,
  q1 TEXT,
  q2 TEXT,
  q3 TEXT,
  q4 TEXT,
  q5 TEXT,
  q6 TEXT,
  q7 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert defaults if not exist
INSERT INTO settings (key, value) VALUES
  ('meta_pixel_id', ''),
  ('meta_api_token', ''),
  ('ga_measurement_id', '')
ON CONFLICT (key) DO NOTHING;
