/* Synthetic workbook path fixture */
%include "&targetStudy.\Dev\Programs\SDTM\autoexec.sas";
%let tdpath=%str("../../../../programs/sdtm/20260131_SYNTH/documents/EXAMPLE001 SDTM Specs_v1.0.xlsx");
proc import out=spec datafile="../../../../programs/sdtm/documents/EXAMPLE001 SDTM Specs_v1.0.xlsx" dbms=xlsx replace;
run;
