export const roomsSchema = `
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)
`;
