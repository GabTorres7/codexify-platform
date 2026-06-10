-- Add granular progress tracking to analyses
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS progress int DEFAULT 0;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS progress_label text DEFAULT '';
