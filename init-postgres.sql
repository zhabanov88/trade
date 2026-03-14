-- Создание необходимых баз данных для DataLens
CREATE DATABASE "us-db";
CREATE DATABASE "compeng-db";

-- Предоставление прав
GRANT ALL PRIVILEGES ON DATABASE "us-db" TO postgres;
GRANT ALL PRIVILEGES ON DATABASE "compeng-db" TO postgres;