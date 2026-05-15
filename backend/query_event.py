import os, json

env_path = r'E:\CulturRoute\.env'
with open(env_path, encoding='utf-8-sig') as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ[k.strip()] = v.strip().strip('"')

from supabase import create_client
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_KEY'])
res = sb.table('events').select(
    'title,start_time,end_time,time_type,ticket_url,source_url,affiliate_links'
).ilike('title', '%地球任務%').execute()

for row in res.data:
    print(json.dumps(row, ensure_ascii=False, indent=2))
