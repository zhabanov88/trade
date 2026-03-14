from sqlalchemy import text
from sqlalchemy.orm import Session


class RunFunction:
    def __init__(self, db: Session):
        self.db = db
        self.func = []

    def run_functions(self):
        results = []
        for f in self.func:
            func_name = f['func_name']
            params = f['params']

            placeholders = ', '.join([f":p{i}" for i in range(len(params))])
            sql = text(f"SELECT {func_name}({placeholders})")

            params_dict = {f"p{i}": params[i] for i in range(len(params))}

            result = self.db.execute(sql, params_dict).scalar()
            results.append({func_name: result})
        return results

    def prepare_functions(self, calls: str):
        function_calls = calls.split(',')
        for call in function_calls:
            parts = call.strip().split('___')
            if parts:
                self.func.append({
                    'func_name': parts[0],
                    'params': parts[1:]
                })
