/* Synthetic ADaM path normalization */
%include "/placeholder/linux/projects/EXAMPLE002/dev/programs/adam/autoexec.sas";
libname trans xport "/placeholder/linux/projects/EXAMPLE002/dev/data/adam/20260228_SYNTH/primary/adlb.xpt";
proc copy in=padam out=trans;
run;
