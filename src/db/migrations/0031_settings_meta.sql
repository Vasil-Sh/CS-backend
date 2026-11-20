-- 0031: Admin «Налаштування» — who changed each setting (the screen shows «змінено 3 лист., @admin»).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS updated_by varchar(100) NOT NULL DEFAULT '';
