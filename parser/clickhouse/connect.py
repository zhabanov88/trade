from clickhouse_driver import Client


class ClickHouseDB:
    def __init__(
        self,
        host='localhost',
        port=9000,
        user='default',
        password='CL4ICLIsdf4HOUOUSE',
        database='default'
    ):
        self.client = Client(
            host=host,
            port=port,
            user=user,
            password=password,
            database=database
        )

    def query(self, sql: str, params=None):
        return self.client.execute(sql, params or None)

    def fetch_one(self, sql: str, params=None):
        result = self.query(sql, params)
        return result[0] if result else None

    def fetch_all(self, sql: str, params=None):
        return self.query(sql, params)

    def insert(self, sql: str, data: list):
        self.client.execute(sql, data)

# db = ClickHouseDB()
# print(db.query("SELECT version()"))