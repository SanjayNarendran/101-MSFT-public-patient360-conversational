"""Table definitions shared by the generator (column order) and the OneLake loader (column types).

Types: INT, NUMBER(p,s) (a decimal), VARCHAR, DATE and TIMESTAMP. 05_onelake_load.py writes them as Delta int,
decimal(p,s), string, date and timestamp (UTC), which the lakehouse SQL analytics endpoints all show.
"""

V, I, D, TS = "VARCHAR", "INT", "DATE", "TIMESTAMP"
DEC = "NUMBER(9,3)"


def cols(spec: str) -> list[tuple[str, str]]:
    """'NAME:TYPE, ...' -> [(NAME, TYPE)]; TYPE codes: V I D TS DEC."""
    types = {"V": V, "I": I, "D": D, "TS": TS, "DEC": DEC, "LOS": "NUMBER(7,2)"}
    out = []
    for part in spec.split(","):
        name, code = part.strip().split(":")
        out.append((name, types[code]))
    return out


CLARITY = {
    # Category (ZC_) lookups
    "ZC_SEX": cols("RCPT_MEM_SEX_C:I, NAME:V, ABBR:V"),
    "ZC_ETHNIC_GROUP": cols("ETHNIC_GROUP_C:I, NAME:V"),
    "ZC_PATIENT_RACE": cols("PATIENT_RACE_C:I, NAME:V"),
    "ZC_MARITAL_STATUS": cols("MARITAL_STATUS_C:I, NAME:V"),
    "ZC_PATIENT_STATUS": cols("PAT_STATUS_C:I, NAME:V"),
    "ZC_DISP_ENC_TYPE": cols("DISP_ENC_TYPE_C:I, NAME:V"),
    "ZC_APPT_STATUS": cols("APPT_STATUS_C:I, NAME:V"),
    "ZC_PAT_CLASS": cols("ADT_PAT_CLASS_C:I, NAME:V"),
    "ZC_ADM_SOURCE": cols("ADMIT_SOURCE_C:I, NAME:V"),
    "ZC_DISCH_DISP": cols("DISCH_DISP_C:I, NAME:V"),
    "ZC_ORDER_TYPE": cols("ORDER_TYPE_C:I, NAME:V"),
    "ZC_ORDER_STATUS": cols("ORDER_STATUS_C:I, NAME:V"),
    "ZC_RESULT_FLAG": cols("RESULT_FLAG_C:I, NAME:V"),
    "ZC_RESULT_STATUS": cols("RESULT_STATUS_C:I, NAME:V"),
    "ZC_PROBLEM_STATUS": cols("PROBLEM_STATUS_C:I, NAME:V"),
    "ZC_PROV_TYPE": cols("PROV_TYPE_C:I, NAME:V"),
    # Master files
    "CLARITY_DEP": cols("DEPARTMENT_ID:I, DEPARTMENT_NAME:V, SPECIALTY:V, REV_LOC_ID:I, REV_LOC_NAME:V, "
                        "CITY:V, STATE:V, ACTIVE_STATUS:V"),
    "CLARITY_SER": cols("PROV_ID:V, PROV_NAME:V, PROV_TYPE_C:I, CLINICIAN_TITLE:V, SPECIALTY:V, SEX:V, NPI:V, "
                        "PRIMARY_DEPT_ID:I, ACTIVE_STATUS:V"),
    "CLARITY_EDG": cols("DX_ID:I, DX_NAME:V, CURRENT_ICD10_LIST:V, SNOMED_CT_CODE:V"),
    "CLARITY_EAP": cols("PROC_ID:I, PROC_NAME:V, PROC_CODE:V, CODE_TYPE:V, PROC_CAT_NAME:V, ORDER_TYPE_C:I"),
    "CLARITY_COMPONENT": cols("COMPONENT_ID:I, NAME:V, EXTERNAL_NAME:V, BASE_NAME:V, LOINC_CODE:V, DEFAULT_UNIT:V"),
    "CLARITY_MEDICATION": cols("MEDICATION_ID:I, NAME:V, GENERIC_NAME:V, STRENGTH:V, FORM:V, THERA_CLASS:V, "
                               "PHARM_CLASS:V, RXNORM_CODE:V"),
    "IP_FLO_GP_DATA": cols("FLO_MEAS_ID:V, FLO_MEAS_NAME:V, DISP_NAME:V, UNITS:V, VAL_TYPE:V, LOINC_CODE:V"),
    # Clinical
    "PATIENT": cols("PAT_ID:V, PAT_MRN_ID:V, PAT_NAME:V, PAT_FIRST_NAME:V, PAT_LAST_NAME:V, BIRTH_DATE:D, "
                    "SEX_C:I, ETHNIC_GROUP_C:I, MARITAL_STATUS_C:I, PAT_STATUS_C:I, DEATH_DATE:D, ADD_LINE_1:V, "
                    "CITY:V, STATE:V, COUNTY:V, ZIP:V, HOME_PHONE:V, EMAIL_ADDRESS:V, CUR_PCP_PROV_ID:V"),
    "PATIENT_RACE": cols("PAT_ID:V, LINE:I, PATIENT_RACE_C:I"),
    "PAT_ENC": cols("PAT_ENC_CSN_ID:I, PAT_ID:V, CONTACT_DATE:D, ENC_TYPE_C:I, APPT_STATUS_C:I, DEPARTMENT_ID:I, "
                    "VISIT_PROV_ID:V, APPT_TIME:TS, ENC_CLOSE_TIME:TS, ENC_CLOSED_YN:V, INPATIENT_DATA_ID:V"),
    "PAT_ENC_HSP": cols("PAT_ENC_CSN_ID:I, PAT_ID:V, ADT_PAT_CLASS_C:I, HOSP_ADMSN_TIME:TS, HOSP_DISCH_TIME:TS, "
                        "ADMIT_SOURCE_C:I, DISCH_DISP_C:I, DEPARTMENT_ID:I, ADMISSION_PROV_ID:V, DISCHARGE_PROV_ID:V"),
    "PAT_ENC_DX": cols("PAT_ENC_CSN_ID:I, LINE:I, PAT_ID:V, CONTACT_DATE:D, DX_ID:I, PRIMARY_DX_YN:V"),
    "PROBLEM_LIST": cols("PROBLEM_LIST_ID:I, PAT_ID:V, DX_ID:I, NOTED_DATE:D, RESOLVED_DATE:D, "
                         "PROBLEM_STATUS_C:I, DIAG_ENC_CSN_ID:I"),
    "ORDER_PROC": cols("ORDER_PROC_ID:I, PAT_ID:V, PAT_ENC_CSN_ID:I, PROC_ID:I, DESCRIPTION:V, ORDER_TYPE_C:I, "
                       "ORDERING_DATE:D, ORDER_INST:TS, PROC_START_TIME:TS, AUTHRZING_PROV_ID:V, ORDER_STATUS_C:I"),
    "ORDER_DX_PROC": cols("ORDER_PROC_ID:I, LINE:I, DX_ID:I"),
    "ORDER_RAD_ACC_NUM": cols("ORDER_PROC_ID:I, LINE:I, ACC_NUM:V"),
    "ORDER_RESULTS": cols("ORDER_PROC_ID:I, LINE:I, PAT_ID:V, PAT_ENC_CSN_ID:I, COMPONENT_ID:I, RESULT_TIME:TS, "
                          "ORD_VALUE:V, ORD_NUM_VALUE:DEC, REFERENCE_UNIT:V, REFERENCE_LOW:V, REFERENCE_HIGH:V, "
                          "RESULT_FLAG_C:I, RESULT_STATUS_C:I"),
    "ORDER_MED": cols("ORDER_MED_ID:I, PAT_ID:V, PAT_ENC_CSN_ID:I, MEDICATION_ID:I, DESCRIPTION:V, ORDERING_DATE:D, "
                      "ORDER_INST:TS, START_DATE:D, END_DATE:D, AUTHRZING_PROV_ID:V, ORDER_STATUS_C:I, REFILLS:I"),
    "ORDER_DX_MED": cols("ORDER_MED_ID:I, LINE:I, DX_ID:I"),
    "IP_FLWSHT_REC": cols("FSD_ID:V, INPATIENT_DATA_ID:V, PAT_ID:V, RECORD_DATE:D"),
    "IP_FLWSHT_MEAS": cols("FSD_ID:V, LINE:I, FLO_MEAS_ID:V, RECORDED_TIME:TS, MEAS_VALUE:V"),
}

CABOODLE = {
    "DateDim": cols("DateKey:I, DateValue:D, DayOfWeek:V, DayOfMonth:I, MonthName:V, MonthNumber:I, "
                    "CalendarQuarter:I, CalendarYear:I, IsWeekend:I"),
    "PatientDim": cols("PatientKey:I, PatientDurableKey:I, PatientEpicId:V, PrimaryMrn:V, Name:V, FirstName:V, "
                       "LastName:V, Sex:V, BirthDate:D, DeathDate:D, Status:V, MaritalStatus:V, Ethnicity:V, "
                       "FirstRace:V, AddressLine1:V, City:V, StateOrProvince:V, County:V, PostalCode:V, "
                       "PrimaryCareProviderDurableKey:I, IsCurrent:I"),
    "ProviderDim": cols("ProviderKey:I, ProviderDurableKey:I, ProviderEpicId:V, Name:V, Type:V, ClinicianTitle:V, "
                        "PrimarySpecialty:V, Sex:V, Npi:V, PrimaryDepartmentKey:I, IsCurrent:I"),
    "DepartmentDim": cols("DepartmentKey:I, DepartmentDurableKey:I, DepartmentEpicId:I, DepartmentName:V, "
                          "DepartmentSpecialty:V, LocationName:V, City:V, StateOrProvince:V, IsCurrent:I"),
    "DiagnosisDim": cols("DiagnosisKey:I, DiagnosisDurableKey:I, DiagnosisEpicId:I, Name:V, Icd10Code:V, "
                         "Icd10Chapter:V, SnomedCtCode:V"),
    "ProcedureDim": cols("ProcedureKey:I, ProcedureDurableKey:I, ProcedureEpicId:I, Name:V, Code:V, CodeSet:V, "
                         "Category:V, OrderType:V"),
    "MedicationDim": cols("MedicationKey:I, MedicationDurableKey:I, MedicationEpicId:I, Name:V, GenericName:V, "
                          "Strength:V, Form:V, TherapeuticClass:V, PharmaceuticalClass:V, RxNormCode:V"),
    "LabComponentDim": cols("LabComponentKey:I, LabComponentDurableKey:I, LabComponentEpicId:I, Name:V, "
                            "CommonName:V, BaseName:V, LoincCode:V, DefaultUnit:V"),
    "FlowsheetRowDim": cols("FlowsheetRowKey:I, FlowsheetRowDurableKey:I, FlowsheetRowEpicId:V, Name:V, "
                            "DisplayName:V, Unit:V, ValueType:V, LoincCode:V"),
    "EncounterFact": cols("EncounterKey:I, EncounterEpicCsn:I, PatientKey:I, PatientDurableKey:I, ProviderKey:I, "
                          "DepartmentKey:I, DateKey:I, EncounterInstant:TS, Type:V, PatientClass:V, AgeInYears:I, "
                          "PrimaryDiagnosisKey:I, IsEdVisit:I, IsHospitalAdmission:I"),
    "HospitalAdmissionFact": cols("HospitalAdmissionKey:I, EncounterKey:I, PatientKey:I, PatientDurableKey:I, "
                                  "AdmittingProviderKey:I, DischargingProviderKey:I, DepartmentKey:I, "
                                  "AdmissionDateKey:I, DischargeDateKey:I, AdmissionInstant:TS, DischargeInstant:TS, "
                                  "LengthOfStayInDays:LOS, PatientClass:V, AdmissionSource:V, DischargeDisposition:V, "
                                  "PrincipalDiagnosisKey:I"),
    "DiagnosisEventFact": cols("DiagnosisEventKey:I, PatientKey:I, PatientDurableKey:I, EncounterKey:I, "
                               "DiagnosisKey:I, StartDateKey:I, EndDateKey:I, Type:V, Status:V, IsPrincipal:I"),
    "ProcedureEventFact": cols("ProcedureEventKey:I, ProcedureOrderEpicId:I, PatientKey:I, PatientDurableKey:I, "
                               "EncounterKey:I, ProcedureKey:I, OrderingProviderKey:I, DateKey:I, OrderType:V"),
    "ImagingFact": cols("ImagingKey:I, ImagingOrderEpicId:I, AccessionNumber:V, PatientKey:I, PatientDurableKey:I, "
                        "EncounterKey:I, ProcedureKey:I, OrderingProviderKey:I, PerformingDepartmentKey:I, "
                        "ExamStartDateKey:I, ExamStartInstant:TS, Modality:V, BodySite:V"),
    "MedicationOrderFact": cols("MedicationOrderKey:I, MedicationOrderEpicId:I, PatientKey:I, PatientDurableKey:I, "
                                "EncounterKey:I, MedicationKey:I, OrderingProviderKey:I, OrderedDateKey:I, "
                                "StartDateKey:I, EndDateKey:I, OrderStatus:V, Refills:I"),
    "LabComponentResultFact": cols("LabComponentResultKey:I, LabOrderEpicId:I, PatientKey:I, PatientDurableKey:I, "
                                   "EncounterKey:I, LabComponentKey:I, ProcedureKey:I, ResultDateKey:I, "
                                   "ResultInstant:TS, Value:V, NumericValue:DEC, Unit:V, Flag:V, ReferenceLow:V, "
                                   "ReferenceHigh:V, IsAbnormal:I"),
    "FlowsheetValueFact": cols("FlowsheetValueKey:I, PatientKey:I, PatientDurableKey:I, EncounterKey:I, "
                               "FlowsheetRowKey:I, DateKey:I, TakenInstant:TS, Value:V, NumericValue:DEC"),
}

SCHEMAS = {"CLARITY": CLARITY, "CABOODLE": CABOODLE}
