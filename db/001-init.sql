CREATE TABLE lessons (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    language text NOT NULL CHECK (language IN ('nl', 'fr', 'de')),
    title varchar(120) NOT NULL,
    content varchar(2000) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lessons_language_id ON lessons (language, id DESC);
CREATE TABLE catalogue_version (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version bigint NOT NULL
);
INSERT INTO catalogue_version VALUES (true, 1);
INSERT INTO lessons (language, title, content)
SELECT language, 'Seed lesson ' || n, repeat('Synthetic lesson content. ', 20)
FROM unnest(ARRAY['nl', 'fr', 'de']) AS language
CROSS JOIN generate_series(1, 10000) AS n;
ANALYZE lessons;
