import psycopg2
from psycopg2.extras import RealDictCursor


class PostgresDB:
    def __init__(
        self,
        host='localhost',
        port=25432,
        user='gpadmin',
        password='GreenPlum',
        database='postgres'
    ):
        self.conn = psycopg2.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database=database
        )
        self.conn.autocommit = True

    def query(self, sql: str, params=None):
        with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            try:
                return cur.fetchall()
            except psycopg2.ProgrammingError:
                return None

    def fetch_one(self, sql: str, params=None):
        with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def fetch_all(self, sql: str, params=None):
        return self.query(sql, params)

    def insert(self, sql: str, data: list):
        with self.conn.cursor() as cur:
            cur.executemany(sql, data)
            self.conn.commit()

    def close(self):
        self.conn.close()


# db = PostgresDB()
# print(db.query("SELECT version()"))