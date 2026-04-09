# Claude Instructions for 09R3.github.io

## Project Context

### Field Ops (`field-ops/`)
A mobile-friendly form app used by field operators to take readings and report
issues found in the field. Readings are saved into a PostgreSQL database.

### Water Ops Viewer (`water-ops-viewer/`)
A database viewer used to access, organize, sort, and analyze the data entered
by field operators. Includes report generation and CSV/Excel/PDF export.

---

## Ports & Deployments

| App | Branch | Appdata Path | Port |
|-----|--------|-------------|------|
| field-ops | `main` | `/mnt/user/appdata/field-ops` | 3067 |
| field-ops | beta (`claude/field-operator-form-app-dEwL1`) | `/mnt/user/appdata/field-ops-beta` | 3066 |
| water-ops-viewer | `main` | `/mnt/user/appdata/water-ops-viewer` | 3069 |
| water-ops-viewer | beta (`claude/database-viewer-reports-i8gRu`) | `/mnt/user/appdata/water-ops-viewer-beta` | 3068 |

---
If any deploy.sh files are updated reminde me to update the one on the server.
---

## Branch Strategy

- **water-ops-viewer** changes → branch `claude/database-viewer-reports-i8gRu`
- **field-ops** changes → branch `claude/field-operator-form-app-dEwL1`
- Beta branches map to the `claude/` feature branches above
- Never push directly to `main`

---

## Version Bumping

**Whenever changes are made to files inside `water-ops-viewer/`**, bump the
patch version in `water-ops-viewer/package.json` before committing.

Use semantic versioning — patch for fixes/small changes, minor for new features:
- Bug fix or tweak → `1.1.0` → `1.1.1`
- New feature → `1.1.0` → `1.2.0`

The version is displayed in the app UI (sidebar footer) and read from
`package.json` via the `/api/version` endpoint — no other files need updating.

## Database Schema

Column notation: `col(PK)` = primary key, `col(→table)` = foreign key

```
_waterops_saved_queries   id(PK), name, sql, created_by, created_at

air_compressors           compressor_id(PK), building_id(→buildings), serial_number, manufacturer, model_number, install_date, certification_expiry_date, status, notes
app_settings              key(PK), value, updated_at
bug_reports               report_id(PK), submitted_by, submitted_at, screen_area, severity, is_repeatable, description, app_version, resolved, resolved_by, resolved_at
building_issues           issue_id(PK), building_id(→buildings), site_id(→sites), building_name, site_name, status, description, reported_date, resolved_date, resolution_notes, entered_by, assigned_to, notes, created_at, updated_at, action_taken, po_number, cost
buildings                 building_id(PK), site_id(→sites), building_letter, building_name, notes
canal_structures          structure_id(PK), structure_name, structure_type, flow_direction, in_service, constructed_date, gate_capacity, design_capacity, operational_capacity, owner, who_maintains, gps_latitude, gps_longitude, has_flow_meter, meter_type, meter_model, meter_status, formula_or_chart_ref, notes
equipment_issues          issue_id(PK), equipment_type, equipment_id, equipment_name, status, description, reported_date, resolved_date, resolution_notes, entered_by, assigned_to, notes, created_at, updated_at, action_taken, po_number, cost
equipment_swaps           swap_id(PK), category, swap_date, location, item_removed_id, item_installed_id, removed_description, installed_description, performed_by, notes, entered_by, created_at
maintenance_buildings     record_id(PK), building_id(→buildings), work_date, work_type, record_type, description, performed_by, is_contractor, entered_by, severity, status, cost, po_number, resolution_notes, next_service_date, notes
maintenance_equipment     maintenance_id(PK), equipment_type, equipment_id, work_date, work_type, performed_by, is_contractor, entered_by, location_at_time, description, parts_used, cost, po_number, hours_at_service, next_service_date, notes
maintenance_vehicles      maintenance_id(PK), vehicle_id(→vehicles), work_date, work_type, performed_by, is_contractor, entered_by, description, odometer_at_service, engine_hours_at_service, parts_used, cost, po_number, next_service_date, next_service_miles, notes, next_service_hours, status
motors                    motor_id(PK), serial_number, manufacturer, model_number, rated_hp, frame_type, oil_capacity_upper_qt, oil_capacity_lower_qt, install_date_current, current_location, status, notes
pesticide_usage           usage_id(PK), pesticide_id(→pesticides), used_date, used_time, applied_by(→users), quantity, location_description, notes, created_at
pesticides                pesticide_id(PK), name, epa_reg_number, unit_of_measure, active, created_at
piezometers               piezometer_id(PK), piezometer_name, pool, sort_order, max_depth, status, gps_latitude, gps_longitude, notes, original_name
pge_meters                pge_meter_id(PK), building_id(→buildings), meter_name, meter_number, account_number, utility_provider, notes
pm_records                pm_id(PK), pm_type, building, completed_date, completed_time, completed_by(→users), checklist(jsonb), notes, created_at
power_monitors            monitor_id(PK), building_id(→buildings), monitor_number, manufacturer, ip_address, notes
pump_positions            position_id(PK,text), site_id(→sites), building_id(→buildings), pump_letter, rated_hp, current_motor_id, current_pump_unit_id, status, notes
pump_units                pump_unit_id(PK), serial_number, manufacturer, model_number, rated_hp, frame_type, forward_flow_rating, reverse_flow_rating, install_date_current, current_location, status, notes
readings_canal            reading_id(PK), structure_id(→canal_structures), reading_date, reading_time, entered_by, instantaneous_flow_cfs, totalizer_reading_af, gate_setting, head_reading_ft, derived_flow_cfs, notes
readings_compressor_hours reading_id(PK), compressor_id(→air_compressors), reading_date, reading_time, hour_reading, entered_by, notes
readings_kf_monthly       kf_reading_id(PK), well_id(→wells), reading_date, reading_time, dtw_reading, operator, plopper_sounder, well_on_off, notes, common_name
readings_pge_meters       reading_id(PK), pge_meter_id(→pge_meters), reading_date, reading_time, kwh_reading, entered_by, notes
readings_power_monitors   reading_id(PK), monitor_id(→power_monitors), reading_date, reading_time, kwh_reading, entered_by, notes
readings_pump_hours       reading_id(PK), position_id(→pump_positions), reading_date, reading_time, hour_reading, entered_by, notes
readings_run_dwr          reading_id(PK), well_id(→wells), reading_date, reading_time, depth_to_water, method, operator, no_measurement(text[]), questionable_measurement(text[]), notes, entered_by, created_at
readings_vehicle_monthly  reading_id(PK), vehicle_id(→vehicles), vehicle_number, reading_date, reading_time, entered_by, odometer_miles, engine_hours, notes
readings_well             reading_id(PK), well_id(→wells), common_name, reading_date, reading_time, on_off, hour_reading, flow_cfs, totalizer, motor_oil, dripper_oil, pge_kwh, entered_by, notes
scada_equipment           scada_id(PK), building_id(→buildings), equipment_number, equipment_name, manufacturer, ip_address, notes
siphon_breaker_swaps      swap_id(PK), swap_date, location, unit_removed_id(→siphon_breakers), unit_installed_id(→siphon_breakers), performed_by, notes, entered_by, created_at
siphon_breakers           pump_unit_id(PK), serial_number, manufacturer, model_number, operating_psi, max_psi, install_date_current, current_location, status, notes
sites                     site_id(PK), site_name, site_type, gps_latitude, gps_longitude, notes
users                     user_id(PK), username(unique), full_name, role, password, initials, email, is_active
vehicles                  vehicle_id(PK), vehicle_number, vehicle_type, year, make, model, vin, license_plate, fuel_type, assigned_user, reading_type, status, notes
well_issues               issue_id(PK), well_id(→wells), well_name, well_area, status, description, reported_date, resolved_date, resolution_notes, entered_by, assigned_to, notes, created_at, updated_at, action_taken, po_number, cost
well_meters               well_meter_id(PK), manufacturer, model_number, serial_number, meter_type, status, well_id(→wells), notes, created_at
well_motors               well_motor_id(PK), manufacturer, model_number, serial_number, hp, status, well_id(→wells), notes, created_at
well_sets                 set_id(PK), set_name, description
wells                     well_id(PK), common_name, state_well_number, area, discharge_pool, participant, agency, kf_set_id(→well_sets), well_type, total_depth_ft, pump_hp, pump_frame_size, pump_unit_id, status, gps_latitude, gps_longitude, notes, is_important, well_run, rp_elev, gs_elev
```
