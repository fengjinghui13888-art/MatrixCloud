from pathlib import Path
from urllib.parse import quote


class Assets:
    def __init__(self,root):self.root=Path(root)/'media'

    def file(self,relative,account_id,note_id):
        if not isinstance(relative,str) or '\\' in relative:return None
        parts=relative.split('/')
        segment=lambda value:quote(value,safe='').replace('.', '%2E')
        if len(parts)!=5 or any(p in ('','..','.') for p in parts) or parts[0]!=segment(account_id) or parts[3]!=segment(note_id):return None
        try:
            root=self.root.resolve(strict=True);file=(root/relative).resolve(strict=True)
            return file if file.is_relative_to(root) and file.is_file() else None
        except (OSError,RuntimeError):return None
