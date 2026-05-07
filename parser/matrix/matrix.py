import json
import os
import asyncio
from nio import AsyncClient, LoginResponse


class MatrixClient:
    def __init__(self, homeserver: str, user_id: str, password: str = None, session_file="matrix_session.json"):
        self.homeserver = homeserver
        self.user_id = user_id
        self.password = password
        self.session_file = session_file

        self.client = AsyncClient(homeserver, user_id)

    async def login(self):
        if os.path.exists(self.session_file):
            with open(self.session_file, "r") as f:
                data = json.load(f)

            self.client = AsyncClient(
                self.homeserver,
                self.user_id,
                device_id=data["device_id"],
                store_path=None
            )

            self.client.access_token = data["access_token"]
            return

        resp = await self.client.login(self.password)

        if not isinstance(resp, LoginResponse):
            raise Exception(f"Login failed: {resp}")

        self._save_session(resp.access_token, resp.device_id)

    def _save_session(self, access_token, device_id):
        with open(self.session_file, "w") as f:
            json.dump({
                "access_token": access_token,
                "device_id": device_id,
                "user_id": self.user_id
            }, f)

    async def send_message(self, room_id: str, message: str):
        print(room_id)
        print(message)
        return await self.client.room_send(
            room_id=room_id,
            message_type="m.room.message",
            content={"msgtype": "m.text", "body": message}
        )

    async def close(self):
        await self.client.close()