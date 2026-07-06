python3 - << 'PYEOF'
FILE = '/opt/trade/HLTradingViewTest-projects/setups-page.js'
with open(FILE, 'r') as f:
    code = f.read()

old = "'>Удалить</button></div>';"
new = "'>Удалить</button></div></div>';"

if old in code and new not in code:
    code = code.replace(old, new, 1)
    with open(FILE, 'w') as f:
        f.write(code)
    print('✓ Исправлено')
elif new in code:
    print('✓ Уже исправлено')
else:
    # Show context around the broken line
    idx = code.find('sp-card-del')
    print('Контекст:', repr(code[idx:idx+100]))
PYEOF