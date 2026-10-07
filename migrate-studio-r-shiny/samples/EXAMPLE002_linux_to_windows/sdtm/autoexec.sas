/* Synthetic SDTM bootstrap */
%let studyid = EXAMPLE002;
libname source "/placeholder/linux/projects/EXAMPLE002/prod/data/edc/20260228_SYNTH";
libname sdtm "/placeholder/linux/projects/EXAMPLE002/dev/data/sdtm/20260228_SYNTH/primary";
%let tdpath=%str("/placeholder/linux/projects/EXAMPLE002/dev/programs/sdtm/documents/EXAMPLE002 SDTM Specs_v1.0.xlsx");
