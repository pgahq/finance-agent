// Tests never call Jev (or any gateway model) unless they opt in and mock the SDK.
process.env.JEV_AUDIT_MODE = 'off';
process.env.JEV_VALIDATION_FIELD_MODE = 'off';
