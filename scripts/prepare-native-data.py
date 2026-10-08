"""Prepare an isolated prototype copy. Never point the native UI at production data."""
import argparse,json,shutil,sqlite3,os
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--resume',action='store_true');p.add_argument('--source',required=True);p.add_argument('--destination',required=True);a=p.parse_args()
src=Path(a.source).resolve();dst=Path(a.destination).resolve()
workspace=Path(__file__).resolve().parent.parent
if src==dst or src in dst.parents or not dst.is_relative_to(workspace/'artifacts'):
    raise SystemExit('Destination must be a separate directory inside workspace/artifacts')
if (dst/"native-prototype.json").exists():raise SystemExit("This copy is finalized; choose a fresh destination")
if dst.exists() and not a.resume:raise SystemExit('Destination already exists; choose a fresh copy or --resume')
dst.mkdir(parents=True,exist_ok=True);(dst/'data').mkdir(exist_ok=True)
with sqlite3.connect((src/'data/app.db').as_uri()+'?mode=ro',uri=True) as source,sqlite3.connect(dst/'data/app.db') as target:source.backup(target)
def extended(path):return '\\\\?\\'+str(path) if os.name=='nt' else str(path)
def copy_file(source,destination):
    if os.path.exists(destination) and os.stat(source).st_size==os.stat(destination).st_size and os.stat(source).st_mtime_ns==os.stat(destination).st_mtime_ns:return destination
    return shutil.copy2(source,destination)
for name in ['accounts','instances','shared','java','languages','fonts','cache']:
    folder=src/'data'/name
    if folder.exists():shutil.copytree(extended(folder),extended(dst/'data'/name),dirs_exist_ok=True,copy_function=copy_file)
if (src/'resources').exists():shutil.copytree(extended(src/'resources'),extended(dst/'resources'),dirs_exist_ok=True,copy_function=copy_file)
with sqlite3.connect(dst/'data/app.db') as db:
    for table,column in [('instances','game_dir'),('instances','java_path'),('accounts','avatar_cache_path')]:
        rows=db.execute(f'SELECT id,{column} FROM {table}').fetchall()
        for identity,value in rows:
            if value and Path(value).is_relative_to(src):
                db.execute(f'UPDATE {table} SET {column}=? WHERE id=?',(str(dst/Path(value).relative_to(src)),identity))
    db.execute("UPDATE launch_history SET process_id=NULL, result='interrupted', ended_at=COALESCE(ended_at,datetime('now')) WHERE result='running'")
    db.execute("UPDATE instances SET status='installed' WHERE status IN ('running','launching')")
    # Rewrite saved Java/runtime and storage roots, including nested JSON values.
    def remap(value):
        if isinstance(value,str) and value.startswith(str(src)):return str(dst)+value[len(str(src)):]
        if isinstance(value,list):return [remap(v) for v in value]
        if isinstance(value,dict):return {k:remap(v) for k,v in value.items()}
        return value
    for key,value in db.execute('SELECT key,value_json FROM settings').fetchall():
        db.execute('UPDATE settings SET value_json=? WHERE key=?',(json.dumps(remap(json.loads(value))),key))
(dst/'native-prototype.json').write_text(json.dumps({'isolated':True,'source':str(src),'root':str(dst)},indent=2))
print('Isolated data copy prepared:',dst)
