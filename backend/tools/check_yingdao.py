"""Read-only official local app readiness check; does not run collection."""
import argparse
import json
from pathlib import Path


def check(root):
    apps = Path(root) / 'apps'
    if not apps.is_dir():
        raise ValueError('未找到 apps 目录，请检查影刀用户文件夹。')
    ready, working, invalid = [], 0, 0
    for folder in apps.iterdir():
        if not folder.is_dir():
            continue
        if not folder.name.endswith('_Release'):
            working += 1
            continue
        try:
            package = json.loads((folder / 'xbot_robot' / 'package.json').read_text(encoding='utf-8'))
            if package.get('robot_type') != 'app' or not package.get('name') or not package.get('uuid'):
                raise ValueError()
            ready.append({'id': package['uuid'], 'name': package['name']})
        except (OSError, ValueError):
            invalid += 1
    return {'readyApps': ready, 'workingFolders': working, 'invalidReleases': invalid, 'collectionExecuted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('user_folder', type=Path)
    result = check(parser.parse_args().user_folder)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['readyApps'] else 2)
