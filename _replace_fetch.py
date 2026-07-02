path = r'C:/Users/julia/OneDrive/Desktop/axenda-admin (3).html'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

OLD = 'fetch(`${BACKEND_URL}'
NEW = 'apiFetch(`${BACKEND_URL}'

before = content.count(OLD)
content = content.replace(OLD, NEW)
after_old = content.count(OLD)
after_new = content.count(NEW)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'fetch BACKEND_URL antes: {before}')
print(f'fetch BACKEND_URL despues: {after_old}')
print(f'apiFetch BACKEND_URL total: {after_new}')
